Two framing decisions drive the whole design, both flowing from your constraints:

- **Input is well-formed, already-lowered JSON.** Both the _program_ (canonical `$call`/`$var`/… AST) and the _types_ (`$sig`/`$types` holding JSON Schema + `$fnType`/`$ref`) arrive as JSON. So the checker never parses shorthand, and — importantly — it can **skip the defensive shape-validation** that `evaluate.ts` does in `classifyExpressionType`. It assumes correctness and classifies with a thin discriminant switch.
- **It's a checker, not an evaluator.** So it diverges from the eval path in two principled ways: it **accumulates diagnostics** (recover-and-continue, assign `any` on error) instead of fail-fast throwing, and it's **bidirectional** (a synth/infer mode _and_ a check-against-expected mode), which §4.3's contextual lambda typing requires.

The file — call it `typescript/src/check.ts` — mirrors `evaluate.ts`'s overall shape (public entry points near the top, internal machinery below, classifiers at the bottom). Eight sections:

## A. Schema-facing types + `CheckContext`

The type-system counterpart to the top of `types.ts`. Since there's no parser, we operate structurally over `JSONType`, with intent-revealing aliases and the one non-schema node:

```typescript
type Schema = JSONType; // canonical-fragment JSON Schema + $ref + $fnType
type FnType = { $fnType: { params: Schema[]; rest?: Schema; returns: Schema } };

type Diagnostic = { path: string[]; message: string; expected?: Schema; actual?: Schema };

type CheckContext = {
  defs: Record<string, Schema>; // module $types pool — the type-NAME scope
  env: TypeEnv; // term → type (Γ) — the buildScope mirror
  sigs: Record<string, FnType>; // module function signatures — registry mirror
  builtins: Record<string, BuiltinRule>; // §5.3 polymorphic rules
  diagnostics: Diagnostic[]; // accumulate; never throw
  path: string[]; // current location, for messages
};
```

`CheckContext` is the deliberate mirror of `EvaluationContext` — same "thread one bag of state through the walk" pattern, but the payload is types + a diagnostics sink instead of `limits`/`state`/`perf`.

## B. Schema classifier (mirrors `getExpressionType` / `classifyExpressionType`)

The single most direct analogue of the eval classifier at `evaluate.ts` lines 1151–1313, but over _schemas_ instead of program nodes:

```typescript
enum SchemaKind {
  Any,
  Never, // true / false
  Primitive, // {type: "string"} etc.
  Const,
  Enum, // {const}, {enum}
  Union, // anyOf, or type-array {type: ["number","null"]}
  Array,
  Tuple, // items vs prefixItems
  ObjectType,
  MapType,
  Ref,
  FnType,
  Opaque, // not/if-then-else/etc. — §5.1 escape hatch
}
function classifySchema(s: Schema): SchemaKind;
```

Plus tiny accessors (`isRef`, `refName`, `isFnType`). This section is pure and gets exercised heavily by both C and E.

## C. Subschema check — `subsumes(sub, sup, seen)` (the core, §5.1)

The heart, and the part with no eval analogue. A structural recursion dispatched on the two schemas' `SchemaKind`s, carrying the **coinductive seen-pairs set** so recursive `$ref`s terminate:

```typescript
function subsumes(sub: Schema, sup: Schema, seen: Set<string>): boolean;
```

Sub-helpers per pairing: primitive/type-array inclusion (`integer ⊆ number`), enum/const membership, numeric+length+items **interval inclusion** for refinements, `pattern`/`format` by syntactic equality, array covariance + tuple pointwise, object required/property/`additionalProperties` rules, union arm-fitting, and function variance (§5.2, params contravariant / return covariant). Boolean schemas (`true`/`false`) and `Opaque` (compatible only with `any`/structural-equal-self) are the base cases.

This is where I'd start the actual coding and unit tests — it's pure `(Schema, Schema) → bool`, testable directly on lowered JSON with zero scope machinery.

## D. Type environment / scope (the `buildScope` / `getVar` mirror)

Two scopes, as we discussed:

- **Type-name scope:** `resolveRef(name, ctx)` over `ctx.defs`. Trivial flat lookup; the recursion guard lives in `subsumes`'s `seen` set.
- **Term scope (Γ):** `buildTypeScope(body, ctx)` mirroring `buildScope` structurally — bind `$sig.params` to their declared schemas, register sibling function `$sig`s, expose `where`-local types. The key simplification: most local types come straight off a declared `$sig`, so this is usually _eager_ (no laziness). Only un-annotated locals need the lazy+cycle-guarded pattern, which reuses the _shape_ of `getVar`'s `resolvingVars` guard (`evaluate.ts` lines 539–568) — returning schemas, not values.

```typescript
type TypeEnv = { lookupType(name: string): Schema | undefined };
function buildTypeScope(body: FunctionBody, ctx: CheckContext): TypeEnv;
```

The pure binding-rule helpers (binding-key filter, `isFnDeclaration`, param→bound-names) are inlined here **for now**; they're the first candidates for the eventual shared `scope.ts` extraction, but we don't touch `evaluate.ts` yet.

## E. Term checking (mirrors `evaluateExpression`)

The big walk. Two mutually-recursive functions instead of eval's single `evaluateExpression`:

```typescript
function synth(expr: JSONType, ctx: CheckContext): Schema; // infer the type
function check(expr: JSONType, expected: Schema, ctx: CheckContext): void; // verify against expected
```

They share a **thin** node classifier — not the full validating one, since input is assumed well-formed:

```typescript
type NodeKind =
  | "scalar"
  | "array"
  | "object"
  | "var"
  | "call"
  | "ref"
  | "body"
  | "if"
  | "cond"
  | "match"
  | "and"
  | "or"
  | "get"
  | "raw";
function nodeKind(node: JSONType): NodeKind; // discriminant-key switch only
```

The switch cases line up 1:1 with `evaluateExpression`'s cases (`evaluate.ts` lines 631–768): `$var` → `env.lookupType`; `$call` → resolve callee sig (registry `$sig` / builtin rule / `$fnType` var / union-of-names §5.4), `check` each arg against its param, return the return schema; `$if`/`$cond`/`$match` → union of branch types + `$match` exhaustiveness lint (§5.6); `$get`/`$from` → project a field/index type out of the target schema; function body → `check` against an expected `$fnType` (contextual typing) or `synth` a `$fnType` from its `$sig`. On any mismatch: push a `Diagnostic` and recover with the expected type (or `any`).

## F. Builtin signature rules (mirrors `stdlib.ts`, §5.3)

The checker-internal polymorphic layer — a table paralleling the stdlib registry:

```typescript
type BuiltinRule = (args: Schema[], exprs: JSONType[], ctx: CheckContext) => Schema;
const BUILTIN_RULES: Record<string, BuiltinRule>;
```

`exprs` (the un-inferred arg nodes) are passed alongside `args` so a rule can push expected types into an inline lambda (`map`'s callback). Start with the load-bearing ones the chess example leans on: `map`/`flatMap`/`filter`, `setAt`, `concat`, arithmetic (`integer`-preserving where both args are `integer`), comparisons → `boolean`.

## G. Signature & module wiring (mirrors `callFunction` / `callProgram`)

```typescript
function checkFunction(body: FunctionBody, ctx: CheckContext): void; // build Γ, check $return vs declared return
function checkModule(module: Record<string, JSONType>): Diagnostic[]; // assemble defs+sigs, check each fn
```

`checkModule` is the public entry, mirroring `callProgram`: it lifts `module.$types` into `ctx.defs`, harvests each binding's `$sig` into `ctx.sigs`, then checks each function body, collecting diagnostics.

## H. Public API + diagnostics

Exports: `checkModule`, `checkExpr` (single-expr synth for the CLI/REPL later), and `subsumes` (exported for unit tests). Diagnostics formatting (schema paths like `params[0].board[12]`, §6) lives here.

---

### Suggested build order (first milestone)

1. **B + C** — classifier + `subsumes`. Pure, no scope, immediately unit-testable on hand-written lowered schema pairs. This proves the hardest algorithm in isolation.
2. **E synth-only + D eager Γ** — infer types for a fully-`$sig`-annotated module (no inference of un-annotated locals, no lambdas yet).
3. **F + `$call` checking + bidirectional lambdas** — the polymorphic builtins and contextual typing, where the real value shows up.
4. **G** — module wiring + diagnostics.

Runtime schema validation (`validate(value, schema)` from §6) is a natural sibling that shares the section-B classifier, but I'd leave it out of this first file until the static side has its feet under it.

The whole thing depends on `evaluate.ts` for **nothing** — it only imports pure types (`JSONType`, `FunctionBody`, `FunctionRegistry`) from `types.ts`. The shared-scope-helper extraction stays a deferred, post-milestone cleanup.
