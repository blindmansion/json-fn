# Runtime representation gaps

Status: investigation; Unicode code-point semantics and the `__proto__`
object-key fix are implemented in the canonical TypeScript implementation
(see section 1), and the portable structural-depth limit is implemented
(see section 2). The Unicode performance/metering work and enforcement of
the selected ill-formed-surrogate policy remain open.

## Summary

Three host-representation details currently leak into json-fn semantics:

1. an object property named `__proto__` is silently lost on some object
   construction paths;
2. deeply nested expression trees can exhaust the JavaScript stack before a
   configured json-fn limit fires; and
3. string indexing can return one half of a UTF-16 surrogate pair.

These are different classes of problem:

- `__proto__` is a data-integrity bug caused by unsafe host object writes;
- host-stack exhaustion is a determinism and resource-limit gap; and
- string indexing is an unspecified Unicode-model decision with surprising
  consequences.

They share a common theme: the language currently exposes behavior inherited
from its JavaScript host without specifying that behavior as part of json-fn.

## 1. `__proto__` can be silently lost

### Reproduction

From `typescript/`:

```sh
bun run src/cli.ts eval --expr '{ "__proto__": { p: 1 } }'
# {}

bun run src/cli.ts eval --expr 'fromEntries([["__proto__", 1]])'
# { "__proto__": 1 }

bun run src/cli.ts eval --json-input \
  '{"$return":{"$raw":{"__proto__":{"p":1}}}}'
# { "__proto__": { "p": 1 } }
```

The shorthand `raw` spelling does not provide the same escape hatch:

```sh
bun run src/cli.ts eval --expr 'raw {"__proto__": { "p": 1 }}'
# {}
```

Canonical JSON has another distinction. A fully constant object can retain the
key because constant evaluation returns the original parsed object:

```sh
bun run src/cli.ts eval --json-input \
  '{"$return":{"__proto__":{"p":1}}}'
# { "__proto__": { "p": 1 } }
```

If evaluation must rebuild the object, the key disappears:

```sh
bun run src/cli.ts eval --json-input \
  '{"$params":["x"],"$return":{"__proto__":{"$var":"x"}}}' \
  --args '[1]'
# {}
```

A string-valued `$comment` also forces a plain data object to be rebuilt so the
comment can be stripped. Such an object loses its `__proto__` property even
when its remaining values are constant.

There is no observed prototype-pollution escape through property access.
Object reads use `Object.hasOwn`, so inherited properties are not visible to a
json-fn program. The immediate problem is silent data loss.

### Cause

JavaScript gives assignment to `__proto__` special behavior on ordinary
objects:

```js
const value = {};
value["__proto__"] = { p: 1 };
Object.hasOwn(value, "__proto__"); // false
```

The assignment invokes the inherited `Object.prototype.__proto__` setter
instead of defining an own data property.

Two canonical implementation paths use this unsafe write:

- `typescript/src/shorthand/parser.ts`, in `parseDataEntry` and raw JSON object
  parsing, builds maps with `map[key] = value`;
- `typescript/src/eval/interpreter.ts`, in `evaluateObjectLiteral`, rebuilds
  dynamic or comment-bearing objects with `evaluatedObject[key] = evaluated`.

This explains the path-dependent behavior:

- shorthand loses the key while parsing, before evaluation;
- a constant canonical object is returned by identity and preserves the key
  created by `JSON.parse`;
- a dynamic canonical object is copied during evaluation and loses the key;
- canonical `$raw` returns its payload without copying and preserves the key;
- shorthand `raw` has already lost the key in its parser object;
- `fromEntries` uses `Object.fromEntries`, which defines an own property and
  preserves the key.

The standard library already has the appropriate technique:
`copyOwnProperty` in `typescript/src/stdlib.ts` uses `Object.defineProperty` so
`pick` and `omit` can copy special keys safely.

### Why this matters

`__proto__` is a valid JSON object key. Whether it survives should not depend
on whether the object came from shorthand, contains a dynamic child, contains
a removable comment, or passed through `$raw`.

Silent loss is particularly dangerous because the result remains well-formed
and no error identifies the omitted field. The current behavior can corrupt
configuration, dictionaries, or externally supplied data without an obvious
failure.

### Direction

This should be treated as an implementation bug rather than a language choice.

**Guest-object invariant:** every JSON key is represented as an own,
enumerable, writable data property. Object construction must preserve that
invariant regardless of the key spelling or construction route.

A small shared helper can use `Object.defineProperty`, either for every key or
at least for `__proto__`. It must be used consistently in:

- shorthand data-object and raw-JSON parsing;
- evaluator object-literal rebuilding;
- closure or transformation passes that rebuild arbitrary data objects;
- checker-generated property and definition maps;
- standard-library transforms, grouping, and entry reconstruction;
- environment and module namespace construction;
- task/workflow serialization and hydration; and
- future codecs and other generic object-construction code.

This is a repository-wide arbitrary-key write audit, not only a parser and
evaluator patch. The shared helper and audit are owned by this plan.
[`raw-semantics-cleanup.md`](raw-semantics-cleanup.md) consumes the helper but
does not reimplement or own the fix.

Null-prototype records would also make assignment safe, but introducing them
as guest values has a wider host-interop impact than defining properties on
ordinary objects.

Conformance coverage should include:

- a constant object with an own `__proto__` key;
- a dynamic object with that key;
- an object that also strips `$comment`;
- shorthand ordinary and `raw` objects; and
- `keys`, `entries`, `$get`, `fromEntries`, `pick`, `omit`, and serialization
  round trips over the key.

### Resolution (implemented in TypeScript)

The shared helper lives in `typescript/src/own-properties.ts`:
`setOwnProperty` defines `__proto__` with `Object.defineProperty` (plain
assignment otherwise), and `getOwnProperty` reads only own properties. The
repository-wide audit converted every object construction keyed by
guest-controlled strings: shorthand data-object, raw-JSON, and type parsing;
evaluator object-literal rebuilding and parameter/let/capture scope maps;
closure substitution; checker property maps and `synthData`; schema merge;
stdlib (`groupBy`, `countBy`, `mapValues`, regex named groups, `pick`/`omit`);
effect-namespace and deployment-registry construction; and the perf counters
(now null-prototype).

The audit also fixed the complementary read-side hole the reproduction work
uncovered: prototype-chain lookups (`registry[name]`, `k in props`) observed
inherited `Object.prototype` members, so calling `toString` or
`hasOwnProperty` invoked the inherited *host* function through
`callExternalFunction`, `groupBy` with a `__proto__` key threw a host
`TypeError`, and a schema requiring a key named `constructor` validated
vacuously. Function-registry resolution, schema property/`$defs`/callable
lookups, effect-manifest and handler-clause lookups, and narrowing-fact reads
now use own-property access.

Conformance coverage: `spec/cases/special-object-keys.json` (evaluation,
stdlib, bindings named `__proto__`, inherited names not callable) and
`spec/cases/parse/special-object-keys.json` (shorthand and `raw` parsing;
the printer round-trip corpus consumes the same cases). Checker, validation,
and helper coverage: `typescript/test/special-object-keys.test.ts`.

## 2. Expression nesting can exhaust the host stack

### Reproduction

A 20,000-level nested array evaluated with high configured limits fails on the
host stack:

```sh
bun -e '
import { callFunction, createStdlib } from "./src/index.ts";
let value = 1;
for (let i = 0; i < 20_000; i++) value = [value];
try {
  callFunction(
    { $return: value },
    [],
    createStdlib(),
    { maxCallDepth: 999_999, maxFuel: 999_999_999 },
  );
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
'
# Maximum call stack size exceeded.
```

A long shorthand addition chain has the same outcome:

```sh
bun -e '
let source = "1";
for (let i = 1; i < 50_000; i++) source += " + 1";
await Bun.write("/tmp/add50k.jfn", source);
'

bun run src/cli.ts eval --file /tmp/add50k.jfn \
  --max-call-depth 1000000 --max-fuel 1000000000
# jfn: evaluation error: Maximum call stack size exceeded.
```

The exact threshold is host-dependent. On one Bun/macOS arm64 run:

- nested array evaluation succeeded at depth 10,000 and failed by 10,500;
- a left-nested `add` tree succeeded at 8,000 terms and failed by 9,000;
- shorthand parsing of explicitly nested arrays failed around depth 2,900;
- shorthand parsing of a 50,000-term `+` chain succeeded because that parser
  loop is iterative, then evaluation failed on the resulting tree.

The existing recursion performance baseline already records
`Maximum call stack size exceeded` for a deep-expression case rather than a
json-fn limit error.

### Cause

The evaluator in `typescript/src/eval/interpreter.ts` is a recursive tree
walker:

- `evaluateArrayLiteral` calls `evaluateExpression` for every child;
- `evaluateFunctionCall` calls `evaluateExpression` for every argument;
- conditionals, property access, closures, and other expression forms recurse
  in similar ways.

The source comments explicitly note that the `evaluateExpression` JavaScript
frame size affects the maximum evaluable nesting depth.

`maxCallDepth` does not measure this recursion. It is incremented in
`callFunctionInternal` and, as documented in `docs/runtime/execution-limits.md`, bounds
nested json-fn function invocations. A deeply nested literal may remain at a
guest call depth of one while consuming thousands of JavaScript frames.

The addition chain also overflows outside the intended call-depth accounting.
Shorthand lowers it to nested `add` calls. Evaluation recursively descends
through call arguments before the outer builtin invocations can complete, so
the expression tree consumes the host stack without creating equivalent
nested guest function calls.

Fuel is charged at `evaluateExpression` entry, but fuel only helps if its
configured value is low enough to fail before the host stack does. With a high
or unlimited fuel budget, stack exhaustion wins. The amount of fuel charged
before that point varies with the host's available stack and frame layout.

This problem is not confined to evaluation:

- nested shorthand array parsing recursively re-enters the expression parser;
- type synthesis recursively walks array and expression trees; and
- closure substitution in `typescript/src/eval/closures.ts` recursively
  rebuilds expressions.

Those phases can have different host-stack thresholds.

### Why this matters

The execution-limit model distinguishes deterministic fuel and call-depth
limits from explicitly non-deterministic cancellation and wall-clock
backstops. Host-stack capacity is currently an undocumented additional
backstop.

Identical programs and explicit limits can therefore:

- succeed on one JavaScript host and fail on another;
- fail before either `maxFuel` or `maxCallDepth`;
- report a host `RangeError` rather than a stable json-fn limit error; and
- consume different reported fuel before failure.

The durable host compounds the mismatch. Its failure classifier recognizes the
documented fuel, value-size, and call-depth messages as limit failures, while a
host stack overflow falls through to a different failure category.

Catching and renaming `RangeError` would improve presentation but would not
make the failure threshold deterministic.

### Considered directions

The complete solution is to evaluate expression trees with an explicit work
stack or trampoline. This would remove ordinary expression nesting from the
JavaScript call stack while preserving json-fn evaluation order. The refactor
would need to preserve:

- exact fuel charging;
- short-circuit and argument evaluation order;
- constant-subtree caching;
- cancellation checks;
- closure creation and variable substitution; and
- task suspension and continuation behavior.

Parser, checker, closure, printer, program-normalization, hashing, and hydration
walks may need similar treatment if the language intends to accept deeply
nested source and canonical values across the full toolchain. `maxCallDepth`
does not bound any of those traversals.

A smaller alternative is a deterministic `maxExpressionDepth` checked below a
conservative host-safe threshold. That produces portable failures but adds a
new limit whose counting rules must be specified. It also rejects expressions
that an iterative evaluator could process safely.

Shape-specific changes, such as flattening associative shorthand operators or
iteratively parsing nested arrays, help individual examples but do not close
the general hole.

### Decision (settled): portable structural-depth limit

**The language contract is a specified, portable structural-depth limit**, not
arbitrary depth subject only to fuel and value size. Exceeding it fails with a
deterministic json-fn limit error, fired consistently before any host stack is
at risk, and the durable host classifies it as a limit failure like fuel,
value-size, and call-depth exhaustion.

The decision is driven by an asymmetry: a documented limit can later be raised
— or removed entirely by implementing iterative walks — without breaking any
accepted program, whereas promising arbitrary depth is irreversible and
immediately obligates every traversal, in every implementation, present and
future, to be written iteratively while exactly preserving fuel, evaluation
order, cancellation, and continuation behavior. Fuel and `maxValueSize`
already bound realistic inputs; nesting beyond a conservative limit is almost
exclusively adversarial or degenerate. A hard cap is also the right defensive
posture at ingestion boundaries such as hashing and hydration, where fuel
offers no protection.

The contract's requirements:

- **One counting rule shared by every traversal.** Depth is the structural
  depth of the JSON tree itself: each nested array element, object entry
  value, or expression subterm adds one level. Parser, checker, evaluator,
  closure substitution, printer, program normalization, hashing, validation,
  and hydration must all reject the same inputs at the same depth, so an
  artifact cannot pass one phase and fail a later one on depth alone.
- **One conservative portable number.** The limit must sit safely below the
  weakest covered traversal on the weakest supported host (measurements above
  show shorthand parsing failing near depth 2,900 while evaluation survived
  past 10,000). A value in the low hundreds (for example 256 or 512) covers
  realistic programs and data with large margin; the exact value is chosen at
  implementation time and documented in `docs/runtime/execution-limits.md` and the
  conformance suite.
- **Conformance coverage at the boundary.** Cases must pin acceptance at the
  limit and the exact error just past it, across the covered traversals.

The escape hatch remains open: if legitimate workloads ever pinch against the
limit — most plausibly deep external data reaching validation, hashing, or
hydration — the response is to make those specific value-side walks iterative
and raise the limit, which is backwards compatible.

### Resolution (implemented in TypeScript)

The constants live in `typescript/src/structural-depth.ts`:
`MAX_STRUCTURAL_DEPTH = 512` with an iterative (explicit work stack,
WeakMap-cached) `assertStructuralDepth`, plus `MAX_EVALUATION_NESTING = 4096`,
a dynamic counter on `CallState` incremented by both `evaluateExpression` and
`callFunctionInternal` so nesting that compounds across guest call frames is
bounded too (per-tree depth alone cannot bound it: call depth multiplies with
the expression depth at each call site).

Enforcement points: shorthand parsing (a descent guard counts source-level
nesting, including grouping parentheses, and the produced canonical tree is
re-verified; raw-JSON islands and the type parser share the guard); program
bodies, arguments, and — because guest programs build values level by level —
results at the `callFunction`/`callProgram`/`prepareProgram` exit boundaries;
`cloneIfNeeded` before `structuredClone`; checker entry; printer entry; schema
fragment/definition-table/callable-signature validation plus depth-guarded
`deepEqual`/`jsonEqual`/`valueMismatch` walks; task serialization and
hydration; workflow records; environment contracts; effect manifests;
deployment profiles; and builtin tables. The durable host's
`mapExecutionFailure` classifies both error prefixes as `"limit"` failures.

Constants were pinned by measurement on Bun (the canonical host): with guards
disabled, the worst reachable shape (recursion through call sites buried
under near-limit literals) overflows the host stack near ~8,000 nesting units
on the main thread and ~6,800 in a worker, giving the 4,096 cap ~1.6x margin;
adversarial shapes (deep call sites, `map`/`reduce` recursion, object sites,
`$let` chains) all fail with the deterministic error in a worker, and
near-limit shapes all succeed. Node's default ~1 MB stack overflows near ~400
units, so Node hosts need a larger stack (e.g. `--stack-size`); the limits are
guaranteed on Bun.

Conformance coverage: `spec/cases/eval/structural-depth.json` (runtime-built
values accepted at 512 and rejected at 513, depth-guarded deep equality, the
nesting-cap error) and `spec/cases/parse/structural-depth.json` (source
nesting at the 512/513 boundary for arrays, objects, and grouping
parentheses). Helper, boundary, checker, printer, validation, hydration, and
closure-growth coverage: `typescript/test/structural-depth.test.ts`. Docs:
`docs/runtime/execution-limits.md` section 4, cross-referenced from
`docs/language/json/execution-limits.md` and `docs/runtime/durable-host.md`.

## 3. Unicode string representation

### 3a. Code-point semantics (implemented)

### Original reproduction

```sh
bun run src/cli.ts eval --expr '"a😀b"[0]'
# "a"

bun run src/cli.ts eval --expr '"a😀b"[1]'
# "\ud83d"

bun run src/cli.ts eval --expr '"a😀b"[2]'
# "\ude00"

bun run src/cli.ts eval --expr '"a😀b"[3]'
# "b"

bun run src/cli.ts eval --expr 'length("a😀b")'
# 4

bun run src/cli.ts eval --expr 'slice("a😀b", 1, 2)'
# "\ud83d"
```

Before the code-point change, the second and third results were the isolated
high and low UTF-16 surrogates that encode `😀` together.

### Original cause

`accessOne` in `typescript/src/eval/property-access.ts` implemented string
indexing with native JavaScript bracket access:

```ts
const value = target[key];
```

JavaScript string indices and `.length` are defined in UTF-16 code units, not
Unicode scalar values or grapheme clusters. The implementation therefore
inherited UTF-16 indexing.

Several related builtins also expose code-unit behavior:

- `length("a😀b")` is `4`;
- `slice`, `split`, `indexOf`, and `includes` use JavaScript string operations;
- produced-value sizing and string-related fuel accounting use `.length`.

Other implementation paths use code points instead:

- `padStart` and `padEnd` use `Array.from`;
- default string comparison iterates strings; and
- the shorthand lexer uses `Array.from`.

The language therefore does not currently have one consistent meaning for
string position or length.

The type and value layers do not reject lone surrogates. A json-fn string is a
JavaScript `string`, and schema length checks also use `.length`. A lone
surrogate can be serialized by `JSON.stringify` as an escape, so it remains
representable in JSON text even though it is not a Unicode scalar value and
cannot be encoded as well-formed UTF-8 without replacement or rejection.

### Why this matters

`docs/language/json/expressions.md` describes integer string indexing as reading a "character."
That term could mean:

- a UTF-16 code unit;
- a Unicode scalar value/code point; or
- a user-perceived grapheme cluster.

Current behavior chooses code units implicitly. It can create a string that was
not present as a character in the input and that downstream Unicode systems may
reject or replace.

This is also a portability issue for the non-canonical implementations:
Python naturally indexes code points, while a direct Go string index yields a
UTF-8 byte. Conformance cases currently use ASCII and do not settle the model.

### Resolution

The canonical TypeScript implementation now uses Unicode code points for
user-visible string positions:

- `$get` string indices;
- `length` on strings;
- string `slice` boundaries;
- string `indexOf` results and `includes` matching;
- `split(string, "")`;
- schema `minLength` and `maxLength`; and
- string `maxValueSize` accounting.

`padStart`, `padEnd`, default string sorting, and shorthand lexing already used
code points. Conformance cases now cover non-BMP characters across the changed
operations.

This means `"a😀b"[1]` is `"😀"` and `length("a😀b")` is `3`. The chosen unit is
not a user-perceived grapheme cluster: combining sequences and multi-code-point
emoji still occupy more than one index.

### 3b. Performance and fuel metering (open)

Code-point `length` and indexing replace constant-time UTF-16 operations with
linear scans; `slice` materializes the whole string; and `indexOf`/`includes`
replace the host's optimized search with allocated arrays and a JavaScript loop
(quadratic in the worst case). The added work needs explicit fuel treatment. A
production implementation should retain native search and slicing where
possible, converting only between UTF-16 offsets and code-point positions and
checking match boundaries.

### 3c. Ill-formed surrogate strings (policy selected)

An accepted json-fn string is a well-formed UTF-16 encoding of Unicode code
points. Unpaired high or low surrogates are invalid guest values.

Validation must reject them at every boundary that accepts external or
reconstructed guest values, including shorthand and canonical JSON input,
public host arguments and results, task/workflow validation and hydration, and
canonical encoding or hashing. A language operation that would produce an
ill-formed string must fail deterministically rather than introduce a value
that cannot later be persisted or hashed. This includes auditing non-Unicode
regex result and replacement paths, which can expose UTF-16 code units even
when their input is well formed.

This policy deliberately defines a portable subset of strings accepted by
JavaScript's `JSON.parse`. It does not reject valid multi-code-point grapheme
clusters, noncharacters, or other well-formed code-point sequences.

## Suggested sequencing

1. **Done.** Fix `__proto__` handling independently. It is a narrow
   correctness defect with no credible compatibility reason to retain. The
   shared helper and repository-wide audit landed (see section 1) before
   program normalization in
   [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md) or generic codec
   reconstruction in
   [`content-addressed-values.md`](content-addressing/content-addressed-values.md).
2. **Done.** Implement the settled structural-depth contract: a portable
   depth limit with one shared counting rule, enforced across the covered
   traversals (see the section 2 resolution). The limits are deterministic
   json-fn errors, not renamed host `RangeError`s.
3. Enforce the selected rejection policy for ill-formed strings at every input,
   production, persistence, hydration, and hashing boundary.

The first two items are fixed in the canonical implementation with
conformance coverage. The third has a settled contract but still requires
implementation and conformance coverage.
