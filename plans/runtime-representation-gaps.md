# Runtime representation gaps

Status: investigation; Unicode code-point semantics are implemented in the
canonical TypeScript implementation. The object-key and host-stack issues, the
Unicode performance/metering work, and enforcement of the selected
ill-formed-surrogate policy remain open.

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
`callFunctionInternal` and, as documented in `docs/execution-limits.md`, bounds
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

### Possible directions

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

Before implementation, decide whether json-fn promises:

1. arbitrary expression depth subject only to fuel, requiring iterative walks;
   or
2. a specified expression-depth limit, enforced consistently before the host
   stack is at risk.

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

`docs/language.md` describes integer string indexing as reading a "character."
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

1. Fix `__proto__` handling independently. It is a narrow correctness defect
   with no credible compatibility reason to retain. Land the shared helper and
   repository-wide audit before program normalization in
   [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md) or generic codec
   reconstruction in
   [`content-addressed-values.md`](content-addressing/content-addressed-values.md).
2. Decide the expression-depth contract, then implement either iterative core
   walks or a portable depth limit. Do not present caught host `RangeError`s as
   deterministic limits on their own.
3. Enforce the selected rejection policy for ill-formed strings at every input,
   production, persistence, hydration, and hashing boundary.

The first item is implementation-defined accidental behavior. The second
requires an explicit language and portability decision. The third now has a
selected policy but still requires implementation and conformance coverage.
