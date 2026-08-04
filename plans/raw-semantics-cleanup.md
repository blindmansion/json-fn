# Raw semantics cleanup

Status: **complete** (all workstreams landed in `typescript/`; see the
workstream summaries below and Workstream H's closing verification at the end
of this status note). The Phase 0 fuel-model decision is settled (stable
virtual cost — see section 5). Workstream A (characterize and separate runtime
identity) has landed in `typescript/`: `src/runtime-values.ts` owns the single
runtime-value mark, `markEvaluated` folded into it (with a constant-cost guard
in evaluator dispatch preserving constant-subtree fuel), the public `raw`
export is removed, and entry arguments/effect results are marked at their host
boundaries. Characterization tests live in `test/runtime-values.test.ts`.
Workstream B (extract constant-expression metadata) has landed:
`src/expression-metadata.ts` owns the static-cost `WeakMap`
(`rememberStaticCost`/`getStaticCost`/`hasStaticCost`), the evaluator keeps
its first-evaluation discovery path, the parser-facing preseed operation is
`rememberStaticCost`, metadata-loss/preseed fuel equivalence is tested in
`test/expression-metadata.test.ts`, and the perf suites measure `$raw`
syntax, runtime values, preseeded static ASTs, discovered constants, and cold
canonical ASTs separately (the old raw-vs-unmarked entry-argument variants
collapsed because entry arguments are auto-marked).
Workstream D (centralize rehydration) has landed: `hydrateTask` and
`hydrateWorkflowRecord` share one rehydration pass
(`restoreRuntimeMarks` in `src/host/task-serialization.ts`) that first
validates every `@task`-tagged shape against the exact constructor shapes
(`taskNodeShapeProblem` in `src/task.ts`) and only then restores runtime-value
marks to the validated task nodes; a workflow record's validated `resume`
continuations are marked from their known fields. Malformed or unknown tagged
shapes are rejected with a path (`TaskShapeValidationError`, or
`WorkflowRecordValidationError` at the durable boundary) on hydration *and* at
persist time, so a forged shape can never poison a stored record. Direct,
serialized, and durable round trips per restored runtime category are tested
in `test/task-rehydration.test.ts`.
Workstream E (decouple `$raw` from fuel) has landed: `staticLiteralCost` in
`src/expression-metadata.ts` is the one normative node-count function shared
by evaluator discovery, parser preseeding, and `$raw` payload charging; the
evaluator's `$raw` branch charges the complete static-literal cost of its
payload (cached by payload identity, computed iteratively, and skipped
entirely when fuel is untracked), so quotation no longer changes
deterministic fuel. Runtime values still re-enter at one node. Perf counters
split the old `rawSkips` into `rawBoundaries`, `runtimeValueSkips`,
`preseededStaticSkips`, and `discoveredStaticSkips`. Ingestion-route fuel
equivalence under exact limits is tested in `test/runtime-values.test.ts`
and pinned portably in `spec/cases/fuel-limits.json`;
`docs/runtime/execution-limits.md` documents the stable virtual-cost rules.
Workstreams F1/F2 (shorthand inference + printer normalization) have landed
as one atomic change: the parser tracks static-literal provenance and cost
from literal grammar paths (`staticCosts`/`rawWrappers`/`pendingPreseeds` in
`src/shorthand/parser.ts`), provisionally accepts quoted `$`-prefixed keys in
static data-object literals, bubbles raw requirements to a maximal `$raw`
boundary, preseeds plain static composites via `rememberStaticCost` at parse
completion (composites absorbed into a raw payload are scrubbed first —
payload interiors are quoted data and must never carry constant-cost
metadata), and no longer has a `raw` keyword (`parseRaw`/`parseRawJson`
removed; `raw` is an ordinary identifier). Module bindings and handler-clause
records are explicit no-inference contexts. The printer renders generic
`$raw` payloads as quoted strict-JSON data with no keyword, rejects
non-canonical reserved-key objects, retains contextual annotated-handle
printing, and its round-trip property is `parse(print(node)) =
normalize(node)` with the canonical normalizer formalized in
`src/shorthand/normalize.ts` (redundant wrapper removal + maximal hoisting).
Parser cases live in `spec/parse-cases/raw-inference.json` (plus updated
`literals.json`, `handle.json`, `special-object-keys.json`); preseeding and
ingestion-route fuel equivalence are tested in
`test/expression-metadata.test.ts`; `examples/dungeon.jfn` dropped its `raw`
spelling.
Workstream G (docs, checker wording, remaining terminology) has landed: the
annotated-handle diagnostic asks for a "static result-type schema", the
`handle` builtin description in `spec/builtins/builtins.json` matches (with
`docs/builtins/builtins.md` regenerated), stale "raw"/"inert" wording in
`src/check/narrowing.ts`, `src/stdlib.ts`, and test names was replaced with
runtime-value terminology, and the docs were rewritten around inference:
`docs/language/shorthand/literals-and-data.md` (quoted-data section, states table,
`parse(print(node)) = normalize(node)` contract, grammar and
contextual-keyword updates, `$raw`-quoted annotated-handle lowering),
`docs/guides/writing-jfn.md` (quoted `$`-keys in static data, computed keys in
dynamic objects), and `docs/language/json/expressions.md` (shorthand-inference note under
`$raw`, canonical annotated-handle spelling). The only bare `raw` left in
docs is the statement that `raw` is an ordinary identifier; shared spec
cases needed no further changes.
Workstream H (verification and cleanup) has landed: `bun run fix`,
`bun run check`, and `bun test` are clean; the `raw-internal`, `boundary`,
`closures`, and `effects` perf suites were run in full against the
workstream-E baseline (`perf/baselines/baseline.json`) — 122 benchmarks
compared, 12 improvements ≥20%, and the single flagged micro-benchmark
regression (`closures/attach-local-fns?localFns=4`, ~14µs → ~20µs) was shown
to be environmental by re-running the identical pre-change code in a worktree
at the baseline commit, which reproduced the same timing. The final
terminology sweep found no `isRaw`/`isInert`/`markEvaluated` references and
updated the last stale perf prose (`perf/README.md` suite descriptions,
`perf/data.ts`, and the collapsed raw-vs-unmarked notes in
`perf/suites/boundary.ts`/`closures.ts`) to runtime-value terminology. The
remaining `raw` spellings refer to canonical `$raw` (expression kind, parser
inference, printer/normalizer) or to undecoded source text in the
lexer/CLI — neither runtime identity nor caching.

## Summary

Keep canonical `$raw`, but give it one job:

> `$raw` is a serializable boundary saying that its payload is a JSON value,
> not json-fn expression syntax.

Remove the user-facing `raw` shorthand keyword. The shorthand parser should
recognize static JSON and insert `$raw` only where a value boundary is needed,
such as around data containing expression-shaped `$` keys. Ordinary static
arrays and objects should stay ordinary canonical JSON and receive a separate,
non-semantic constant-expression cache hint.

At runtime, replace the current overloaded `raw` terminology with an explicit
runtime-value marker. Keep constant-expression caching separate from both
canonical `$raw` and runtime values.

The resulting model has three concepts:

1. **Canonical `$raw`** — serializable language semantics: payload is value,
   not syntax.
2. **Runtime value marking** — ephemeral identity metadata: an object already
   produced as a value must not be reinterpreted as syntax.
3. **Constant-expression metadata** — ephemeral optimization metadata: a
   source subtree is statically constant and can skip traversal while retaining
   its specified fuel cost.

No backwards compatibility is required. The canonical spelling `$raw` remains,
but redundant uses may normalize away when printed through shorthand.

## Motivation

Today “raw” covers several related but distinct mechanisms:

- `{ "$raw": value }` is a canonical expression form.
- `raw(value)` adds an object to a runtime `WeakSet`.
- `markEvaluated(value)` adds an object to a second `WeakSet`.
- `isRaw(value)` means membership in either set.
- `isInert(value)` means membership in only the first set.
- plain constant program subtrees use a separate
  `constantEvaluationCosts` cache.
- shorthand `raw <json>` is both the data/syntax escape hatch and an explicit
  first-traversal performance hint.

This makes it difficult to state what “raw” guarantees. Some marks survive JSON
serialization because they are syntax (`$raw`); others disappear because they
are object-identity metadata. Some change language behavior; others should
change only performance. `isRaw` hides these distinctions from callers.

The shorthand syntax also exposes an implementation concern to authors. A
large static data object currently invites `raw`, even when it contains no
expression-shaped data. Conversely, arbitrary external JSON needs a genuine
data/syntax boundary when it contains keys such as `$var`, `$call`, or
`$return`.

## Goals

- Make ordinary static JSON require no special shorthand keyword.
- Preserve arbitrary JSON data, including expression-shaped `$` keys.
- Keep canonical `$raw` as the serializable data/syntax boundary.
- Remove `$raw`'s role as a fuel/performance escape hatch.
- Ensure serialization can lose optimization metadata without changing
  results, errors, or deterministic fuel.
- Give runtime value identity and constant-AST caching separate APIs and names.
- Simplify closure capture, task construction, and hydration invariants.
- Preserve the canonical TypeScript implementation's checker and evaluator
  behavior for genuinely quoted data.
- Consume the safe own-property construction mechanism owned by
  [`runtime-representation-gaps.md`](runtime-representation-gaps.md).

## Non-goals

- Do not reconcile the lagging Go, Python, and Rust implementations as part of
  this work.
- Do not redesign the whole canonical expression vocabulary.
- Do not add imports, external data loading, or a new host serialization
  format.
- Do not make runtime identity marks serializable.
- Do not use static inference to execute or constant-fold calls such as
  `add(1, 2)`.

## Proposed semantics

### 1. `$raw` remains canonical

The canonical form remains:

```json
{
  "$raw": {
    "$var": "this is data"
  }
}
```

Evaluating it returns the payload as a runtime value without interpreting
`$var`.

The checker continues to synthesize the payload structurally as JSON data and
does not collect variables, function references, or module references from
inside it.

`$raw` is no longer documented as a way to make a constant cheaper. Its reason
to exist is semantic quotation: it preserves a JSON value where the same tree
would otherwise be interpreted as json-fn syntax, or where a syntax-owned
context explicitly needs static metadata. The generated result schema for an
annotated `handle` is one such metadata context.

### 2. Shorthand infers the boundary

Remove:

```jfn
raw { "$var": "this is data" }
```

Accept ordinary strict/static JSON instead:

```jfn
{ "$var": "this is data" }
```

The quoted `$` key tells the parser that this is a data-object spelling, not
canonical syntax authored directly in shorthand. Because the entire object is
static, it lowers to the canonical `$raw` form above.

Ordinary static JSON does not need a canonical wrapper:

```jfn
{
  rooms: ["cell", "hall", "gate"],
  enabled: true
}
```

It lowers to the same ordinary array/object tree it does today. The parser may
record constant-subtree metadata for it, but that metadata is not part of the
JSON result.

Dynamic collections remain expression containers:

```jfn
{
  name: user.name,
  limits: { retries: 3, timeout: requestedTimeout }
}
```

The static `{ retries: 3 }` portions can be cached where useful, while the
containing objects remain dynamic.

If a dynamic object needs a literal `$`-prefixed key, the existing computed-key
path remains explicit:

```jfn
{ ["$status"]: status }
```

A quoted `$` key in an ordinary object is accepted only when the containing
candidate can be proven static. For example, this is rejected:

```jfn
{ "$status": status }
```

It cannot be a raw JSON value because `status` is an expression, and treating
it as a normal canonical object would collide with reserved syntax.

### 3. Raw inference is maximal

When a static subtree contains a quoted `$` key, wrap the largest surrounding
static literal rather than producing nested wrappers.

```jfn
{
  envelope: {
    payload: { "$call": "not code", "$args": [] }
  }
}
```

should lower conceptually to:

```json
{
  "$raw": {
    "envelope": {
      "payload": {
        "$call": "not code",
        "$args": []
      }
    }
  }
}
```

If the surrounding object is dynamic, only the maximal static child is raw:

```jfn
{
  receivedAt,
  payload: { "$call": "not code", "$args": [] }
}
```

lowers conceptually to:

```json
{
  "receivedAt": { "$var": "receivedAt" },
  "payload": {
    "$raw": {
      "$call": "not code",
      "$args": []
    }
  }
}
```

Parser-generated `$raw` nodes must retain provenance long enough for a static
parent to absorb their payload. The parser must not infer rawness by blindly
walking arbitrary lowered canonical nodes, because function bodies, calls,
schemas, and other syntax are themselves JSON.

### 4. Shorthand printing uses normalization

Generic `$raw` payloads print as ordinary strict JSON, without a `raw` keyword.
Parsing that output reconstructs `$raw` whenever the boundary is semantically
necessary.

Some canonical `$raw` nodes are redundant:

```json
{ "$raw": [1, 2, 3] }
```

With `$raw` no longer serving as a performance hint, the shorthand printer may
normalize this to:

```jfn
[1, 2, 3]
```

and reparsing may produce the plain canonical array. Therefore the printer
contract becomes:

```text
parse(print(node)) = normalize(node)
```

rather than exact identity for every accepted, non-normal canonical tree.

Contextual forms remain exact. In particular, a raw third argument to
`handle` continues to print as:

```jfn
handle task returns ResultType with { ... }
```

and reparses to the same annotated-handle representation.

The normalizer should remove only semantically redundant `$raw` wrappers. It
must retain wrappers needed for:

- expression-shaped or reserved-key payloads;
- literal `$comment` preservation;
- generated functions, continuations, and handler maps embedded as values;
- syntax-owned metadata such as annotated-handle result schemas; and
- any other context where removing the wrapper would cause evaluation or
  checker traversal.

Scalar `$raw` is redundant and should normalize to the scalar. It need not have
a shorthand spelling.

### 5. Fuel is independent of quotation and caches

Today a `$raw` wrapper costs one unit regardless of payload size, while an
ordinary constant tree costs its full expression-node count. That makes `$raw`
a semantic performance/fuel control.

**Phase 0 decision (settled): fuel is a stable virtual cost**, independent of
parser metadata, caches, serialization, and ingestion route. Fuel is a pure
function of the program, its inputs, and recorded effect results. This
preserves deterministic limits across durable suspension and hydration even
when actual preparation work differs: caches, skipped traversals, and lost
metadata may change host preparation time only, never fuel, results, or
errors. Wall-clock timeout and cancellation remain the host's protection
against actual-work divergence, as `docs/runtime/execution-limits.md` already
documents.

Under this model, quoting a static value does not reduce deterministic fuel.
The `$raw` wrapper replaces evaluation of the payload root, but the complete
literal carries the same deterministic cost as the equivalent static literal.

The normative static-literal cost function is:

```text
staticLiteralCost(null | boolean | number | string) = 1
staticLiteralCost(array)  = 1 + sum(staticLiteralCost(element)) over elements
staticLiteralCost(object) = 1 + sum(staticLiteralCost(value)) over entry values
```

That is, one unit per JSON value node of the produced value; object keys are
not separately charged. This matches what first evaluation of an equivalent
plain constant literal charges today (one `evaluateExpression` entry unit per
node). Where plain-literal syntax and quotation produce different values — for
example `$comment` entries, which literal syntax strips and `$raw` preserves —
each form charges the node count of the value it actually produces.

The `$raw` equation is:

```text
rawCost(payload) = staticLiteralCost(payload)
```

`staticLiteralCost` includes the payload root in the same way as evaluation of
the equivalent ordinary constant literal. Because `evaluateExpression` already
charges its universal expression-entry unit, the `$raw` branch charges the
remaining `staticLiteralCost(payload) - 1`; the entry unit must not be counted
twice.

The runtime may use cached/precomputed cost metadata to charge that amount
without traversing the payload during evaluation. If metadata was lost through
serialization, the first evaluation may walk the payload to compute its cost,
but it must charge the same amount.

Runtime values that re-enter expression position continue to cost one node:
they were already produced and accounted for at their original boundary.

This separation guarantees:

- shorthand parse followed by direct evaluation;
- shorthand parse, JSON serialization, and canonical JSON evaluation; and
- independently constructed canonical JSON

have the same result and deterministic fuel. Only host-side preparation work
may differ.

## Internal runtime model

### Runtime values

Replace `raw()`, `isRaw()`, and `isInert()` with APIs whose names state the
runtime invariant, for example:

```ts
markRuntimeValue(value)
isRuntimeValue(value)
```

A runtime value is an object or array that has already crossed from expression
syntax into value space. If it later appears in expression position, it must be
returned as a value rather than classified from its keys.

Mark runtime values at the existing semantic boundaries:

- evaluating canonical `$raw`;
- accepting public entry arguments;
- binding/substituting a non-function parameter or local value;
- returning from a json-fn, builtin, host function, or host callback;
- constructing task nodes and generated closed continuations;
- resuming task continuations with produced values;
- wrapping runtime-contract function values; and
- hydrating serialized task/workflow records.

Function bodies authored as source syntax must still go through closure
construction. Function values that have already been closed are runtime values.
The implementation must preserve this distinction in function-call and
capture paths.

The public `raw(value)` API should be removed. Host arguments and host results
already cross explicit call boundaries and should be marked automatically.
There should be no requirement for a host author to understand interpreter
identity metadata.

### Evaluated-result marking

The current `_evaluatedValues` set and `markEvaluated()` should be folded into
runtime-value marking if characterization tests confirm that every marked
result is semantically a value.

This is expected to simplify the current asymmetry:

- `isInert` skips expression classification;
- `isRaw` combines explicit raw and evaluated sets for closure/cache skips; and
- an evaluated expression-shaped object can behave differently depending on
  which predicate a path uses.

If a characterization test finds a genuine case where an evaluated object must
be reinterpreted as source syntax, retain a separate marker but name it
`isEvaluatedResult` and document that path explicitly. Do not restore a union
predicate named `isRaw`.

### Constant-expression metadata

Move `constantEvaluationCosts` out of the interpreter's private implementation
into a small neutral metadata module, for example:

```text
typescript/src/expression-metadata.ts
```

It should expose narrowly scoped operations such as:

```ts
rememberStaticCost(node, cost)
getStaticCost(node)
```

Both the shorthand parser and evaluator may populate the same `WeakMap`.
Neither should mark the AST object as a runtime value.

Properties of this metadata:

- object-identity based;
- non-serializable;
- safe to lose;
- affects traversal work only;
- never changes classification, results, errors, or fuel; and
- stores the complete deterministic cost that must still be charged.

## Parser design

### Literal provenance

Track static-literal information only for nodes produced by literal grammar
paths. A suitable parser-local shape is:

```ts
type StaticLiteralInfo = {
  payload: JSONType;
  cost: number;
  requiresRaw: boolean;
};
```

The implementation may return this alongside parsed values or store it in a
parser-local `WeakMap` for arrays and objects. Scalars can be handled directly.
This is parse-time provenance only: it must never be reconstructed by walking
lowered canonical `$let`, `$args`, module, or function-body JSON.

Rules:

- null, booleans, numbers, and strings are static;
- an array literal is static when every non-spread element is static;
- a data-object literal is static when every ordinary value is static and it
  has no spread or computed entry;
- calls, variables, function references, function bodies, conditionals,
  ascriptions, templates with holes, and lowered dynamic collection operations
  are not static;
- parser-generated `$raw` children contribute their payload and
  `requiresRaw = true` to a static parent;
- a quoted `$`-prefixed key sets `requiresRaw = true`;
- a bare `$`-prefixed data key remains invalid;
- a static parent with `requiresRaw` emits one `$raw` wrapper;
- a static parent without `requiresRaw` stays plain and records its static
  cost; and
- a dynamic parent keeps any already-materialized raw child boundaries.

Do not apply inference to:

- the module root;
- `$let` binding maps built by lowering;
- `$args` arrays created by call lowering;
- parameter and function-body records;
- type syntax or definition pools;
- handler-clause records where the checker relies on the literal record shape;
  and
- arbitrary canonical nodes after lowering.

Most handler records contain functions and are naturally dynamic. The empty
handler case requires an explicit no-inference parser context so it remains a
handler record rather than becoming a raw value.

### Safe object construction

Safe arbitrary-key construction is a prerequisite owned by
[`runtime-representation-gaps.md`](runtime-representation-gaps.md). Its shared
own-property helper and repository-wide audit must land before shorthand raw
inference. This plan consumes that helper in parser paths; it does not own a
second `__proto__` fix.

## Checker and task behavior

The checker retains a dedicated raw node kind:

- synthesize the payload as structural data;
- do not resolve `$var`, `$call`, `$fn`, `$ref`, or function-body-looking
  records inside generic raw data;
- do not collect free variables or module references inside raw payloads; and
- preserve literal `$comment` keys.

Annotated `handle` remains parser sugar over a raw schema argument. The
callable rule should describe this as a static result schema rather than asking
authors for a “raw schema,” since authors no longer write the wrapper.

Task code continues to use canonical `$raw` when it embeds an already-produced
handler map, continuation, closure, or schema into newly generated serializable
expression syntax. This is a genuine value/syntax boundary, not an
optimization.

Live task records and closed continuation objects use runtime-value marking.
Their JSON serialization loses the mark. Hydration must restore runtime marks
from stable structural tags and known workflow fields in one centralized
rehydration pass. The pass first validates the complete record and each known
task, continuation, and handler shape; only validated fields receive restored
runtime-value marks.

## Implementation steps

The normative implementation order is:

1. characterize runtime boundaries and exact current fuel;
2. introduce precise runtime-value APIs;
3. extract static-cost metadata;
4. centralize and validate task/workflow rehydration;
5. implement ingestion-independent `$raw` fuel;
6. atomically enable shorthand inference, remove the `raw` keyword, and change
   shorthand printing/normalization; and
7. migrate checker wording, tasks, examples, docs, tests, and performance
   instrumentation.

The workstreams below inventory the detailed edits; their lettering is not a
license to violate that ordering.

### Workstream A: Characterize and separate runtime identity

1. Add focused characterization tests around:
   - expression-shaped host arguments and results;
   - function-valued results;
   - closure capture and substitution;
   - explicitly raw canonical payloads;
   - task nodes and generated continuations;
   - task/workflow serialization and hydration; and
   - current fuel for raw, evaluated, and cached constant values.
2. Add a dedicated runtime-value marker module or rename the relevant portion
   of `typescript/src/utils.ts`.
3. Replace `isRaw` call sites with the precise invariant each one needs.
4. Fold `markEvaluated` into runtime-value marking if the characterization
   tests confirm the expected model.
5. Remove the public `raw` export and mark host arguments/results at their
   actual boundaries.
6. Update task constructors, runtime-contract wrappers, and closure
   substitution to use runtime-value terminology. Centralized hydration lands
   as its own ordered step after static-cost extraction.

Primary files:

- `typescript/src/utils.ts`
- `typescript/src/index.ts`
- `typescript/src/eval/interpreter.ts`
- `typescript/src/eval/closures.ts`
- `typescript/src/runtime-contract.ts`
- `typescript/src/task.ts`
- `typescript/src/host/task-serialization.ts`
- `typescript/src/host/durable/workflow-record.ts`

### Workstream B: Extract constant-expression metadata

1. Move `constantEvaluationCosts` and its access rules into a neutral internal
   module.
2. Preserve the evaluator's automatic first-evaluation discovery path for
   canonical JSON not produced by the shorthand parser.
3. Add a parser-facing operation to preseed a proven static subtree and its
   complete deterministic cost.
4. Verify that deleting metadata or serializing/reparsing a program changes
   performance counters only, not fuel or results.
5. Update performance suites so “runtime value,” “preclassified static AST,”
   and “cold canonical AST” are measured separately instead of grouped under
   “raw.”

Primary files:

- `typescript/src/eval/interpreter.ts`
- `typescript/src/expression-metadata.ts` (new)
- `typescript/perf/suites/raw-internal.ts`
- `typescript/perf/suites/boundary.ts`
- `typescript/test/interpreter-performance-regressions.test.ts`

### Workstream D: Centralize rehydration

1. Define one durable/task hydration entry point.
2. Decode to plain JSON and validate the complete workflow record.
3. Validate known task, continuation, closure, handler, and resume-value shapes.
4. Restore runtime-value marks only to validated fields.
5. Reject malformed or unknown tagged shapes before evaluation.
6. Test direct, serialized, and durable round trips for every restored runtime
   category.

Primary files:

- `typescript/src/host/task-serialization.ts`
- `typescript/src/host/durable/workflow-record.ts`
- `typescript/src/task.ts`
- `typescript/src/eval/closures.ts`

### Workstream F1: Implement shorthand inference

1. Add parser-local static-literal provenance and cost tracking.
2. Allow quoted `$`-prefixed keys provisionally in data-object literals.
3. Reject them if the containing candidate is dynamic.
4. Bubble raw requirements through static parents and emit a maximal `$raw`
   boundary.
5. Preseed constant metadata for ordinary static composite literals.
6. Remove the `raw` primary-expression branch, `parseRaw`, and `parseRawJson`.
7. Remove `raw` from shorthand grammar and contextual-keyword documentation.
8. Use the prerequisite shared own-property helper from
   `runtime-representation-gaps.md`.
9. Preserve explicit no-inference contexts such as handler-clause records.

Primary files:

- `typescript/src/shorthand/parser.ts`
- `typescript/src/shorthand/lexer.ts` if keyword assumptions require changes
- `typescript/src/shorthand/cursor.ts` if parser provenance needs shared cursor
  support
- `spec/parse-cases/literals.json`
- `spec/parse-cases/handle.json`

Required parser cases:

- ordinary static scalar, array, and object;
- nested ordinary static data without `$raw`;
- top-level and nested expression-shaped data;
- maximal raw bubbling through arrays and objects;
- dynamic parent with a raw static child;
- quoted `$` key with a dynamic value rejected;
- computed `$` key with a dynamic value accepted;
- bare `$` key rejected;
- `__proto__`, `constructor`, and `$comment` preservation;
- empty handler record remains a handler record; and
- `raw` becomes an ordinary identifier rather than a keyword.

### Workstream F2: Normalize shorthand printing

Workstreams F1 and F2 are one atomic compatibility change. The parser must not
stop accepting a spelling that the printer still emits, and the printer must
not emit inferred raw syntax until that syntax reparses correctly.

1. Print generic `$raw` payloads as strict JSON without a keyword.
2. Add or formalize a canonical normalizer used by printer round-trip tests.
3. Retain contextual annotated-handle printing.
4. Normalize redundant raw wrappers around scalars and collision-free static
   JSON.
5. Preserve wrappers whose removal would expose syntax, comments, generated
   code-as-value, or static metadata.
6. Change the printer property from exact identity to identity after
   normalization.

Primary files:

- `typescript/src/shorthand/printer.ts`
- `typescript/test/print-spec.test.ts`
- `typescript/test/parse-spec.test.ts`

### Workstream E: Decouple raw from fuel

1. Define one static-literal node-count function shared by cold discovery,
   parser-preseeded constants, and `$raw` payloads.
2. Change `$raw` evaluation to charge the complete static cost while skipping
   expression interpretation.
3. Cache raw payload cost by object identity after it is computed.
4. Preserve the one-node re-entry cost for runtime values.
5. Update usage reporting and performance counters to distinguish:
   - raw syntax boundaries;
   - runtime-value skips;
   - parser-preseeded static skips; and
   - evaluator-discovered constant skips.
6. Add equivalence tests comparing direct shorthand evaluation, serialized
   canonical evaluation, and independently parsed canonical JSON under tight
   fuel limits.

This workstream must pass before Workstreams F1/F2 may remove redundant `$raw`
wrappers during normalization.

Primary files:

- `typescript/src/eval/interpreter.ts`
- `typescript/src/eval/execution.ts`
- `typescript/src/expression-metadata.ts`
- `typescript/src/types.ts`
- `docs/runtime/execution-limits.md`

### Workstream G: Migrate task, checker, specs, and examples

1. Update checker diagnostics and comments to reserve “raw” for canonical
   quotation.
2. Verify annotated-handle static schema typing and runtime enforcement.
3. Update task generation and hydration tests for the new runtime marker names.
4. Remove explicit shorthand `raw` from `examples/dungeon.jfn`.
5. Rewrite shorthand and language documentation around automatic data
   inference.
6. Update shared conformance and parse cases.
7. Regenerate generated documentation if any builtin specification changes.

Primary files:

- `typescript/src/check/ast.ts`
- `typescript/src/check/checker.ts`
- `typescript/src/check/module.ts`
- `typescript/src/check/callable-rules.ts`
- `typescript/src/task.ts`
- `docs/language/json/expressions.md`
- `docs/language/shorthand/index.md`
- `docs/runtime/execution-limits.md`
- `examples/dungeon.jfn`
- `spec/cases/`
- `spec/parse-cases/`

### Workstream H: Verification and cleanup

From `typescript/`:

```sh
bun run fix
bun run check
bun test
```

Then run focused performance suites for constant literals, runtime boundaries,
closures, and tasks. Compare:

- cold canonical JSON;
- shorthand-parsed AST with metadata;
- the same AST after JSON serialization;
- explicitly raw expression-shaped data; and
- hydrated durable task records.

Finally, search for remaining `raw`, `isRaw`, `isInert`, and `markEvaluated`
references. Every remaining use should refer unambiguously to canonical `$raw`,
not runtime identity or caching.

## Coordination with content addressing

This cleanup should land before the plans under `plans/content-addressing/`.
The features are otherwise mostly orthogonal, but they share representation
boundaries that must use the cleaned-up terminology and normalization rules.

### Program normalization is context-sensitive and is not value normalization

Module identity pinning hashes the normalized authored program component
defined by `content-addressing/module-identity-pinning.md`, so redundant
`$raw` spellings do not give semantically equivalent deployments different
identities. The program normalizer is context-sensitive: it distinguishes
expression syntax, syntax-owned metadata, and quoted guest data.

Content-addressed value storage hashes arbitrary guest values. It must not run
the program normalizer over those values: guest data may legitimately contain
objects that look like `$raw` or any other expression form. The value codec
canonicalizes JSON bytes (key order, number spelling, and UTF-8) but preserves
the value's exact structural content.

Keep these as separate APIs:

```ts
normalizeProgram(program)
canonicalEncodeJsonValue(value)
```

Hash inputs should also be versioned and domain-separated, for example
`jfn:deployment:v1` versus `jfn:value:v1`, so a module identity and a stored
value cannot be confused merely because their encoded JSON bytes match.

### Hydration ordering

Content-addressed storage recreates object identities and therefore loses all
runtime `WeakSet` metadata. A durable load must perform these stages in order:

1. fetch and verify referenced blobs;
2. decode blob references and reconstruct the complete plain JSON record;
3. validate the reconstructed record;
4. restore runtime-value marks on task nodes and known continuation fields; and
5. enter evaluation.

The blob codec must not attempt to serialize runtime-value or constant-cost
metadata. Restoring marks belongs to the centralized runtime hydration pass,
not to individual blob decoders.

### Lazy references

The deferred lazy-reference runtime should build on this cleanup rather than
introducing another meaning of rawness. Its runtime categories should remain
distinct:

- canonical `$raw` — serialized syntax/value boundary;
- runtime value — already-produced live JSON;
- static-cost metadata — non-semantic AST optimization; and
- lazy ref — storage-backed runtime representation that may be forced.

Lazy forcing must integrate with the resulting deterministic cost model.
Whether a value was inline, parser-preclassified, eagerly hydrated, or reached
through a lazy ref must not accidentally select a different `$raw` or
constant-subtree fuel rule.

## Expected benefits

- Shorthand authors treat JSON as JSON and do not manage evaluation hints.
- Arbitrary expression-shaped data remains representable and portable.
- `$raw` has one durable semantic meaning.
- Runtime values cannot accidentally become syntax based on object keys.
- Cache loss through serialization cannot alter deterministic execution.
- Closure and task code state whether they are handling syntax, values, or
  cached ASTs.
- Performance tests measure the actual mechanism they intend to measure.
- The parser absorbs the only unavoidable complexity: deciding which
  source-authored literal boundaries require canonical quotation.

The parser gains some bookkeeping, but the evaluator, closure, task, host, and
documentation models become substantially clearer.

## Risks and mitigations

### Static provenance mistakes

Misclassifying a dynamic expression as static would silently change behavior.
Track provenance from literal grammar paths rather than reclassifying arbitrary
canonical objects, and test every expression form nested in arrays and objects.

### Function-value boundaries

Folding `markEvaluated` into runtime-value marking could bypass closure
construction if applied to source function bodies. Characterize source
functions, returned closures, captured closures, and evaluated callees before
consolidating the sets.

### Printer normalization

Removing the `raw` spelling means structurally redundant canonical wrappers
cannot round-trip exactly. Make normalization explicit, narrow, tested, and
documented rather than allowing accidental printer drift.

### Fuel migration

Existing low-fuel cases may change because raw payloads are no longer free.
Update the normative model first, then change implementation and fixtures
together. Test equivalent ingestion paths with exact limits.

### Deep static JSON

Parser analysis, raw-cost calculation, checker synthesis, and normalization are
recursive walks and may encounter the existing host-stack depth gap. Do not
claim that this cleanup solves arbitrary nesting. Every new static-cost,
normalization, or hydration traversal must be iterative or comply with the
depth contract owned by
[`runtime-representation-gaps.md`](runtime-representation-gaps.md). Reuse
memoized analysis and avoid repeated subtree walks.

### Object-key integrity

Automatic JSON ingestion would make the existing `__proto__` loss more visible.
Use safe own-property definition consistently and retain dedicated regression
coverage.

## Estimated scope

This is a medium-to-large TypeScript refactor rather than a parser-only tweak.
An expected implementation window is approximately three to five focused days:

- one day for characterization and runtime-marker separation;
- one day for parser inference and printer normalization;
- one day for fuel/cache separation;
- one to two days for task/checker migration, fixtures, documentation,
  performance verification, and edge cases.

The work should land in the phases above so each conceptual separation remains
reviewable and testable.
