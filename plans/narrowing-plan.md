# §5.5 Narrowing — implementation plan

Status: **build order — M0 ✅ + M1 ✅ + M2 ✅ + M3 ✅ + §5.6 lint ✅ landed.**
Scoped the single biggest gap in the typechecker. Since this plan was written the
monolithic `check.ts` has been split into the `typescript/src/check/` package
(`checker.ts`, `narrowing.ts`, `context.ts`, `builtin-rules.ts`, `module.ts`,
`schema.ts`, `subsumption.ts`, `values.ts`, `ast.ts`); line references below use
the new files (the module-exports map at the bottom is the index). Grounded in
the current code, the design sketch (`type-sketch.md` §5.5), and the
empirically-confirmed wall in the Tier-2 chess tests
(`typescript/test/check/chess.test.ts`). Decisions marked **[D]**; open forks gathered
at the end.

---

## 0. The wall, restated

> **Historical.** This section describes the pre-narrowing state. M0 (warning
> downgrade) and M1 (flow narrowing for params & direct vars) have since landed,
> so the false positive below is now gone for the param-guarded case. Kept for
> context; the milestone write-ups carry the as-built notes.

The dominant idiom in real code is **guard-then-use**: a value typed `T | null`
(or a wider union) is checked with a guard, then used on the branch where the
guard rules out the bad arm.

```
pieceColor: (piece: Cell) =>          // Cell = Piece | null
  if isNull(piece) then null
  else if piece == upper(piece) then "w" else "b"   // upper wants string
```

The checker performs **no flow narrowing today** (§5.5 option 1 isn't even
wired). So in the `else` branch `piece` keeps its declared `Cell = Piece | null`
type, `upper`'s `(string) -> string` sees `Piece | null ⊄ string`, and a false
positive fires. `check()` (`checker.ts:423`) and the builtin arg loop in
`applyOverload` (`builtin-rules.ts:161`) both ran a bare
`isSubschema(actual, expected)` and pushed an **error** on failure — there was
no notion of a runtime-checkable mismatch.

The Tier-2 tests now **assert the narrowed outcome** rather than pin the wall
(`check/chess.test.ts`, `describe("chess fragments — Tier 2")`): `pieceColor` asserts
**zero** diagnostics (M1), `makePiece` asserts a **warning** (M0), and a
genuinely-disjoint case stays an **error**. Those assertions are the regression
anchor — each milestone below flipped a specific one.

### What each idiom needs (chess, worked)

| Function | Guard | Narrowed thing | Milestone |
|---|---|---|---|
| `pieceColor`, `otherColor` | `isNull(piece)` on a **param** | direct var | M1 |
| `pieceGlyph` | `isNull(piece)` on a param, indexing `PIECES[piece]` | direct var | M1 |
| `pieceMoves` | `isNull(piece)`, `piece` a **lazy local**; `type`/`color` forced only in `else` | lazy local, forcing-site | M2 |
| `slideDir`, `steppingMoves`, `pawnMoves` | `cond { !ok -> …, empty -> … }` where `empty: isNull(target)` is a **boolean local** | narrowing through a named boolean guard | M2 |
| `parseMove`, `moveResult` | `!isNull(from) && !isNull(to)`, then `{from, to}`; `isNull(move)` then `move.from` | local + **field path** | M3 |
| `isLegalMove`, `hasAnyLegalMove` | `!isNull(piece)` local, `pieceColor(piece) == color` | local + boolean-guard | M2 |

So: **M1 unblocks the param-guarded functions, M2 unblocks the bulk (lazy
locals + boolean guards), M3 cleans up the field-path / discriminant tail.**
Milestone 0 (below) is the cheap, unconditional unblock that ships first.

---

## Milestone 0 — `severity` + warning downgrade (§5.5 option 1) **[✅ landed — commit 2160692]**

**As built:** `Severity`/`severity` live on `Diagnostic` (`context.ts:17`, `:23`);
`report` defaults to `"error"` (`context.ts:65`). The narrowable-mismatch
predicate is `narrowableMismatch` + `decomposeArms` (`checker.ts:394`, `:408`),
and `reportMismatch` (`checker.ts:413`) picks the severity at the single mismatch
site now shared by `check()` and the builtin arg/return checks. Original plan
below.

The sketch's recommended v1: *don't narrow*, but stop reporting narrowable
mismatches as hard errors. Downgrade them to **warnings** that map to runtime
boundary checks (§6). This is the "least engineering unblocks the most real
code" path the status note flagged, and it is a prerequisite for the runtime
side regardless of whether M1–M3 ever land.

### 0.1 Add `severity` to `Diagnostic` (Section A)

```typescript
type Severity = "error" | "warning";
type Diagnostic = {
  path: string[];
  message: string;
  severity: Severity;          // NEW — default "error"
  expected?: Schema;
  actual?: Schema;
};
```

`report()` (`context.ts:65`) gains an optional severity (default `"error"`), so
existing call sites are unchanged.

### 0.2 The narrowable-mismatch predicate

A mismatch `actual ⊄ expected` is a **warning** (runtime-checkable, narrowing
*would* fix it) rather than an **error** (no value could ever pass) when the two
are **not disjoint** — some value satisfies both. Cheap approximation that
covers the `T | null` case exactly and reuses `subsumes`:

```typescript
// Some arm of `actual` fits `expected` ⇒ a guard could narrow to it.
function narrowableMismatch(actual: Schema, expected: Schema, defs: Defs): boolean {
  const arms = decomposeArms(actual, defs);   // unionArms ∪ per-literal ∪ [self]
  return arms.some((a) => isSubschema(a, expected, defs));
}
```

- `Piece | null ⊄ string` but `Piece ⊆ string` → **warning**. ✔ (pieceColor)
- `string ⊄ integer`, no arm fits → **error** (stays hard). ✔
- `PieceType | string ⊄ Piece` (the `lower` case, `makePiece`) → `PieceType ⊆
  Piece`, `string ⊄ Piece` → **warning**. This correctly reclassifies the §5.3
  precision case too — the widened `string` arm becomes a runtime check, not a
  false error. (Note: this means M0 also softens the `makePiece` test, not just
  the narrowing ones — call that out in the test update.)

### 0.3 Wire it in

The comparison sites emit warnings instead of errors when `narrowableMismatch`
holds. As built these were unified into one `reportMismatch` helper
(`checker.ts:413`), called from:

- `check()` (`checker.ts:430`).
- `applyOverload` arg check (`builtin-rules.ts:181`) and lambda-return check
  (`builtin-rules.ts:201`).

### 0.4 Runtime tie-in (§6) — stated, not built here

A warning names a boundary where a schema must be validated at runtime. Host
enforcement levels (`off | boundaries | everything`) decide whether warnings are
silent, checked at fn entry, or checked everywhere. M0 only produces the
diagnostics carrying `expected`/`actual`; emitting the runtime `valueSatisfies`
guards is the §6 work item and stays out of this milestone.

### 0.5 Assertion operator — follow-up, gated on open Q9

An explicit assert (`x!` / `assert(x, T)`) should *silence* a warning by
narrowing to the asserted type. Its surface syntax and whether it emits an AST
node vs. checker-only metadata is `type-sketch.md` open Q9 and isn't settled.
Checker-side hook when it is: a new `nodeKind` `"assert"` whose `synth` returns
the asserted schema (and, under `everything`, plants a runtime check). Deferred.

### 0.6 Tests

- Extend `Diagnostic` assertions to check `severity`.
- Flip Tier-2 `pieceColor` / `makePiece`: expect **warning**, not error;
  the module is otherwise clean.
- Add a genuinely-disjoint case (`string` where `integer` expected) that stays
  an **error** — proves the predicate discriminates.

**Exit:** the chess piece/parse layer type-checks with zero *errors* (warnings
where narrowing is still owed). This is the load-bearing unblock.

---

## Milestone 1 — flow narrowing for params & direct vars (§5.5 option 2, core) **[✅ landed — commit 0a9efd2]**

**As built:** all of M1 lives in `narrowing.ts` plus the control-flow wiring in
`checker.ts`. `ctx.narrowings` is on `CheckContext` (`context.ts:53`);
`factsFromCondition` (`narrowing.ts:164`) recognizes the `isNull`/type-predicate
family, `not`, `eq`/`neq`, and `$and`/`$or` conjunction; the narrowing operators
are `restrictToType`/`removeType`/`restrictToLiteral`/`excludeLiteral`
(`narrowing.ts:98`–`143`). `synth`'s `"var"` case reads the fact first
(`checker.ts:250`) and the `if`/`cond`/`match` cases thread facts per arm
(`checker.ts:306`, `:315`, `:332`). One soundness extra beyond the plan:
`isUnshadowed` (`narrowing.ts:157`) refuses to narrow on a user-shadowed builtin
guard name. Original plan below.

Real narrowing, restricted to the tractable case: the guarded thing is a plain
`$var` (a param or an eagerly-bound name), and narrowing applies within the
lexical extent of a single `$if`/`$cond`/`$match` arm.

### 1.1 Narrowing facts on the context

```typescript
type CheckContext = {
  // …existing…
  narrowings?: Record<string, Schema>;   // var name → already-intersected type
};
```

The `"var"` case of `synth` (`checker.ts:250`) consults `ctx.narrowings[name]`
before `env.lookupType(name)`. Values are the **result** of intersecting the
declared type with the fact, so `synth` stays a lookup.

### 1.2 Guard extraction

```typescript
// Facts learned when `cond` evaluates truthy (sense=true) / falsy (sense=false).
function factsFromCondition(
  cond: JSONType, sense: boolean, ctx: CheckContext,
): Record<string, Schema>;
```

Recognized guard forms (all present in chess):

- `isNull(x)` → true: `x : null`; false: `x : removeNull(declared)`.
- `not(g)` / `!g` → recurse with flipped `sense`.
- `eq(x, <lit>)` / `x == <lit>` → true: `x : {const lit}` (if admissible);
  false: `excludeLiteral(declared, lit)` (meaningful for enums; no-op otherwise).
- `neq` → mirror of `eq`.
- `isString`/`isNumber`/`isBool`/`isArray`/`isObject`/`isNull` family → true:
  `restrictToType(declared, t)`; false: remove that primitive arm.
- `$and` (true sense) → **conjunction** of arm facts (later facts refine
  earlier). `$or` (false sense) → conjunction of negated arms. The dual cases
  (`$and` false / `$or` true) yield no sound single-var fact → skip.

Only facts whose subject is a bare `$var` are kept in M1; anything else is
dropped (picked up in M3).

### 1.3 Schema narrowing operators

Targeted meets — not a general schema intersection (kept out of the tractable
fragment on purpose):

- `removeNull(s)`: drop `{type:"null"}` / `"null"` from an `anyOf` / type-array;
  drop `null` from an enum. `Cell → Piece`, `T | null → T`.
- `restrictToType(s, t)`: keep only arms compatible with primitive `t`.
- `restrictToLiteral(s, v)` / `excludeLiteral(s, v)`: enum membership surgery.

Each returns `false` (never) when nothing remains — which then makes a
subsequent use trivially well-typed (dead branch), consistent with laziness.

### 1.4 Wire into control flow

In `synth`'s `if` / `cond` / `match` cases (`checker.ts:306`–`362`), thread
facts into the child context of each result arm:

- `$if`: `$then` gets `factsFromCondition($if, true)`; `$else` gets `…false`.
- `$cond`: arm *i*'s result gets the **conjunction** of the negations of conds
  `0..i-1` plus the positive of cond *i* (dominating-guard accumulation);
  `$else` gets all conds negated.
- `$match` on `$var x`: case `[lit, result]` gets `x : {const lit}`; `$else`
  gets `x` with all matched literals excluded (this is also the §5.6
  exhaustiveness signal — shared machinery).

Facts merge into `ctx.narrowings` (child arm only; sibling arms unaffected).

### 1.5 Tests

- `pieceColor` → **zero diagnostics** (flip the M0 warning back to clean).
- `otherColor` already clean; add a negative-narrowing case
  (`if x == "w" … else` narrows the enum).
- `pieceGlyph`-shaped: `if isNull(p) then "·" else PIECES[p]` where `PIECES`
  is a map keyed by `Piece` — proves narrowing feeds `$get`/index projection.

---

## Milestone 2 — lazy-local narrowing at forcing sites (the hard part) **[✅ landed]**

**As built:** `buildTypeScope` (`checker.ts`) now returns `{ env, guards }` and
carries a two-tier cache — the un-narrowed `memo` (fast path) plus a
`narrowedMemo[name][key]` keyed by `stableStringify` of the *relevant* fact
subset. A per-local `freeVarsOf` (over-approximated by `collectVars`, which skips
only `$raw`) gates re-synth: `lookupType(name, narrowings)` intersects free vars
with the active facts and stays byte-identical to before when the intersection is
empty. `TypeEnv.lookupType` gained the optional `narrowings` arg (`context.ts`),
`synth`'s `"var"` case passes `ctx.narrowings` down for the indirect case, and
`stableStringify` lives on `context.ts`. Boolean-guard narrowing (§2.3) is a
`ctx.guards` map (lazy-local name → binding expr, outer-merged) that
`factsFromCondition` recurses through for a bare-var condition, cycle-guarded by a
`seen` list (covers the depth-2 `ok: not(empty)` alias and falls back on cycles).
Divergent-force diagnostics are structurally de-duplicated at the end of
`checkModule` via `dedupeDiagnostics`. Tests: `describe("chess fragments — Tier 3
…")` in `check/chess.test.ts`. Original plan below.

This is where the bulk of chess lives, and where the current architecture
actively fights us. M2 is fundamentally a **`buildTypeScope` redesign**
(`checker.ts:84`), not an additive hook.

### 2.1 Why the current scope can't narrow (as-built)

`buildTypeScope` splits a body's bindings into `eager` (params + sibling
functions) and `exprLocals` (un-annotated locals, typed lazily). A lazy local is
synthesized **once**, memoized in `memo[name]`, inside the `env.lookupType`
closure (`checker.ts:120`):

```typescript
resolving.push(name);
try {
  const s = synth(exprLocals[name]!, { ...ctx, env, path: [name] });
  return (memo[name] = s);
} finally {
  resolving.pop();
}
```

Two consequences block narrowing:

1. The synth runs under the **build-time `ctx`** captured in the closure. The
   forcing site's `ctx.narrowings` never reach it, so a local forced inside
   `else (piece non-null)` is still typed with `piece : Cell`.
2. A single `memo` slot can't hold a local whose type **differs per fact set** —
   and under narrowing it must (`type` in `pieceMoves` is forced only where
   `piece` is non-null).

One structural fact makes this tractable: locals are forced **only** by
reference from `$return` (transitively). `checkFunction` (`module.ts:20`) checks
`$return` and recurses into *sibling function* bodies; it never force-walks a
non-body local. So a narrowing-only local (`type`, `color` in `pieceMoves`) is
*only ever* forced under its guard — there is no un-narrowed force to emit a
spurious warning, which is why re-synth-under-facts is sound and cheap here.

### 2.2 Approach **[D — re-synth under facts, free-variable gated]**

Three coordinated changes.

**(a) Thread the forcing narrowings into resolution.** `TypeEnv.lookupType`
(`context.ts:30`) gains an optional narrowings argument:

```typescript
type TypeEnv = {
  lookupType: (name: string, narrowings?: Record<string, Schema>) => Schema | undefined;
};
```

`synth`'s `"var"` case (`checker.ts:250`) already returns a **direct** narrowing
on `name`; the new work is the **indirect** case — a local that *references* a
narrowed var. It passes the active facts down:

```typescript
const t = ctx.env.lookupType(name, ctx.narrowings);
```

Every other caller (`ref`, `resolveCalleeSig`, `isUnshadowed`, `currentType`)
keeps calling `lookupType(name)`: a function's `$fnType` never narrows, so they
stay on the fast path, and the default-`undefined` arg keeps them
source-compatible.

**(b) Free-variable gate.** Compute, once per lazy local (memoized,
cycle-guarded on the existing `resolving` walk), the set of `$var` names it
**transitively** references. Over-approximate for soundness: keep every name
seen *and* expand any name that is itself a lazy local (so `a: b`, `b: piece`
gives `freeVars(a) ⊇ {piece}`); ignore shadowing by inner-lambda params (a
superset only ever costs a harmless extra re-synth — never a stale type). On
`lookupType(name, narrowings)`:

- `relevant = freeVars(name) ∩ keys(narrowings)`.
- `relevant` empty → return the un-narrowed `memo[name]` (today's fast path,
  byte-for-byte unchanged).
- else → re-synth under the facts (part c).

**(c) Fact-keyed cache.** Replace the single memo with two tiers:

- `memo[name]` — the un-narrowed type (fast path).
- `narrowedMemo[name][key]` — `key = stableStringify(pick(narrowings, relevant))`.

Keying on only the *relevant* subset collapses distinct-but-irrelevant fact sets
onto one entry, so re-synth is bounded by "locals that actually depend on a
narrowed var, under distinct relevant fact sets" — shallow DAGs in chess.
Re-synth runs `synth(exprLocals[name], { ...capturedCtx, env, narrowings, path: [name] })`.

**(d) Diagnostics.** Re-synth emits the local's diagnostics under the **narrowed**
facts — that is the point: the un-narrowable warning must vanish exactly where
the guard proves it safe. Cache-by-key already dedupes repeat forces under the
same facts. The only exposure is a local forced under **two distinct** relevant
fact sets (per-arm divergence): each key synths once, so its internal
diagnostics could appear twice.

**[D — structural dedupe at the end of `checkModule` (`module.ts:34`).]** Before
returning `ctx.diagnostics`, drop later diagnostics that are structurally equal
to an earlier one (same `path` + `message` + `severity` + `expected` + `actual`,
compared by a stable stringify). This is cheap, order-stable (keep first
occurrence), and leaves the common single-fact-set path byte-identical. It is
deliberately *not* first-seen-fact-set suppression, which would be unsound — an
error present only under a later arm must still surface (a distinct diagnostic
survives dedupe precisely because it isn't structurally equal).

### 2.3 Narrowing through a named boolean guard

The `cond { !ok -> …, empty -> … }` idiom (`slideDir`, `steppingMoves`,
`pawnMoves`, `isLegalMove`, `hasAnyLegalMove`) guards arms with **boolean
locals** (`empty: isNull(target)`), not inline predicates. `factsFromCondition`
(`narrowing.ts:164`) returns `{}` today for a bare `$var` condition, so nothing
narrows.

- Add `guards?: Record<string, JSONType>` to `CheckContext`, populated by
  `buildTypeScope` with each lazy local's **binding expression** (name → expr).
- Extend `factsFromCondition`: when `cond` is a bare `$var b` and `ctx.guards[b]`
  exists, recurse into that expression and return its facts (`empty →
  isNull(target)` → `{ target: … }`). The recognizer is the M1 machinery — **no
  new guard forms**.
- **[D — alias depth 2.]** A boolean local may alias another (`ok: not(empty)`,
  `empty: isNull(target)`), which is a two-hop chain: `$var ok` → `not(empty)` →
  `isNull(target)`. Depth 2 covers exactly that (the deepest form in chess);
  chains longer than two hops are cycle-guarded and fall back to the M0 warning.

This one addition unblocks the `cond`-heavy layer end to end.

### 2.4 Refinements attach to forcing, not binding (§5.5 point 3)

Falls out for free: because locals are typed (and, later, contract-checked) at
their **forcing site**, a computed-but-unused value (`slideDir`'s out-of-bounds
`tIdx`, `steppingMoves`'s `target` on the `!ok` arm) is never forced on the dead
branch, so its refinement contract never fires. No eager-contract false alarms.
Design invariant, no code this milestone: refinement enforcement (§2.6/§6) must
hang off forcing, and hot internal helpers (`toIdx`) stay loosely typed by
design.

### 2.5 Tests

- `pieceMoves`: `isNull(piece)` (a **local**) then `match`/arm uses of
  `type`/`color` → zero diagnostics. (Indirect narrowing through the free-var
  gate.)
- `slideDir` fragment: `cond` guarded by `empty`/`!ok` boolean locals → clean.
  (Boolean-guard alias expansion, §2.3.)
- `parseMove` (partial): `!isNull(from) && !isNull(to)` then `{from, to}` —
  clean for the var part (field access is M3).
- Per-arm divergence: the same local forced in two arms under different facts
  yields two different **types** (proves the memo split) **and** does not
  double-report diagnostics (proves the §2.2(d) dedupe).
- Fast-path guard: a module with no narrowing produces byte-identical
  diagnostics to today (proves the gate leaves the common path untouched).

---

## Milestone 3 — field-path & discriminant narrowing (stretch) **[✅ landed]**

**As built:** the fact key space on `ctx.narrowings` generalized from bare var
names to **static access paths**. `asPath` (`ast.ts`) canonicalizes a `$var` /
literal-string `$get` chain to a dot-joined string (`"move.from"`, `"x.tag"`); a
single-segment path is the plain var name, so M1/M2 bare-var facts are unchanged.
`projectField` moved to `schema.ts` as a pure `(target, key, defs)` op so both
`synth`'s `$get` case and narrowing can share it without a cycle. Production:
`factsFromCondition`'s type-predicate branch now takes an `asPath` subject and
computes its current type via `currentTypeOfExpr` (`narrowing.ts`, projects
through the base), and `equalityFact` recognizes a `base.field == lit`
discriminant, narrowing the *base* var via `restrictToDiscriminant` (keep arms
whose `field` admits the literal on true; drop the exact-`const` arm on false).
Consumption: `synth`'s `$get` case reads `ctx.narrowings[asPath(expr)]` before
projecting (mirrors the `"var"` case). The M2 re-synth engine picks path facts up
because `collectVars` now records the path string alongside its root var, so the
free-var gate re-synthesizes a local that reaches through a narrowed path. Tests:
`describe("chess fragments — Tier 4 …")` in `check/chess.test.ts`. Original plan below.

The tail: narrowing subjects that are **paths**, not bare vars.

- **Nullable field / element:** `isNull(move)` then `move.from`
  (`moveResult`) — narrow the path key `move` and let `$get` projection
  (`projectField`, `checker.ts:157`) see the narrowed target.
- **Field-path facts:** `eq(x.tag, "A")` narrows `x` to the union arm whose
  `tag` is `const "A"` — discriminated-union narrowing. Keying facts by a
  path string (`"move"`, `"x.tag"`) generalizes `ctx.narrowings`.
- **Synergy with §5.6:** discriminant detection here and the `$match`
  exhaustiveness lint share the "shared `const` field across union arms" scan;
  build them together.

Field-path narrowing multiplies the re-synth surface (paths, not just names);
gate it behind the same free-variable analysis and only enable for the
recognized discriminant/isNull forms.

---

## §5.6 — `$match` exhaustiveness & dead-case lints **[✅ landed]**

A follow-on to M3, sharing its residual/discriminant machinery. Two lints, both
`severity: "warning"` (json-fn's `$match`/`$cond` fall through at runtime, so a
missed case is a *smell*, not unsound — same tier as the M0 narrowable warnings).

**As built:** three helpers in `narrowing.ts` (`enumerateLiterals`,
`discriminantValues`, exported `caseUniverse`) compute the **finite universe** of
values a `$match` subject can take:

- **Enum / union-of-consts / `null` / `boolean`** subjects → `enumerateLiterals`
  over the synthesized subject type (an enum var, a `T | null`, etc.).
- **Discriminant path** `base.field` → `discriminantValues` scans the base
  union's arms and collects each arm's `field` const. This generalizes the
  arm-scan in `restrictToDiscriminant` (M3): narrowing asked "which arm does this
  narrow to?", the lint asks "what tags exist to cover?". It is *needed* because
  `projectField` over a union collapses to `any`, so `synth(s.tag)` alone can't
  see the tag set.
- `caseUniverse` returns `null` when the universe isn't finite (a `string`/
  `number` subject), so the lint stays quiet where exhaustiveness is undecidable.

The `match` case of `synth` (`checker.ts`) now:

- captures the subject type from the (already-issued) `synth(m.$match)` call and
  computes `universe = caseUniverse(...)`;
- collects `caseLiterals` (every literal case value) independently of the
  bare-var narrowing, so path subjects (`s.tag`) participate;
- **dead case:** a case literal not in `universe` → `Unreachable $match case …`
  at `$cases[i][0]`;
- **exhaustiveness:** when there is **no `$else`**, every case is a literal, and
  `universe` has values no case covers → `Non-exhaustive $match: unhandled
  case(s) …` at the match node. (Canonical `$match` requires `$else`, so this
  fires only on the deliberately-elided shape — the checker is robust to it and
  the lint is precisely about that shape; `$else` present ⇒ exhaustive by
  construction, no warning.)

The `$else` branch is now synthesized only when present (previously unconditional).

Tests: `describe("chess fragments — Tier 5 …")` in `check/chess.test.ts` — enum miss →
one warning; full enum → clean; discriminated-union miss → warning; dead case →
warning; `$else` present suppresses; infinite subject → no lint.

**Not built:** `$cond` exhaustiveness (its `$else` *is* optional, but each arm's
covered literal must be extracted from a guard predicate — fuzzier; deferred).

## Cross-cutting

- **Soundness stance:** narrowing is a *sound refinement* (facts only ever
  shrink a type). When a guard form isn't recognized, we fall back to the M0
  warning path — never a silent pass. The system stays honest.
- **Perf:** the free-variable gate (§2.2) keeps the no-narrowing path identical
  to today; re-synth is opt-in per dependent local. Watch the `checkModule`
  chess run for regressions.
- **Interaction with the builtin layer:** facts live on `CheckContext`, so they
  flow into `applyOverload`/`inferLambdaReturn` (`builtin-rules.ts:161`, `:118`)
  unchanged — a narrowed var used as a builtin arg is already narrowed at `synth`
  time. (Confirmed by M1: no builtin-layer edits were needed.)
- **Coinductive `seen` set** (subsumes) is orthogonal; narrowing ops produce
  plain schemas that re-enter `subsumes` normally.

## Suggested order & exit criteria

1. **M0** ✅ — `severity` + warning downgrade. *Exit met:* chess piece/parse
   layer has zero **errors**; Tier-2 tests assert warnings. Shipped
   independently; unblocks §6 runtime work.
2. **M1** ✅ — param/var narrowing. *Exit met:* `pieceColor`/`pieceGlyph`-shaped
   projection fully clean.
3. **M2** ✅ — lazy-local + boolean-guard narrowing (the `buildTypeScope`
   redesign). *Exit met:* `pieceMoves`/`slideDir`/`parseMove` fragments clean;
   per-arm divergence test passes (memo split + diagnostic dedupe); no-narrowing
   fast path unchanged.
4. **M3** ✅ — field-path / discriminant narrowing. *Exit met:* nullable-field
   (`isNull(move.from)` then `move.from`) and discriminated-union
   (`s.tag == lit`) fragments clean; disjoint field use stays a hard error; lazy
   local through a path narrows at its forcing site.
5. **§5.6** ✅ — `$match` exhaustiveness & dead-case lints, reusing M3's
   residual/discriminant scan. *Exit met:* enum/discriminated-union matches
   missing a case warn; full matches are clean; dead cases warn; infinite
   subjects are not linted.

## Open forks

1. ~~**M0 vs. M1 as the true "next step".**~~ **Resolved:** both landed
   (M0 → M1), as recommended.
2. **Assertion operator (open Q9)** — blocks the "silence a warning explicitly"
   ergonomic; needs a syntax/AST decision before the checker hook.
3. ~~**Diagnostics under divergent re-synth (M2).**~~ **Resolved:**
   re-synth-under-facts + fact-keyed cache (§2.2), with a **structural dedupe at
   the end of `checkModule`** (§2.2(d)) for the divergent-force case. First-seen
   suppression rejected as unsound.
4. ~~**Boolean-guard alias depth (M2 §2.3).**~~ **Resolved: depth 2** — covers
   the deepest chess chain (`ok: not(empty)`, `empty: isNull(target)`); longer
   chains fall back to the M0 warning.

## Module exports reference (`typescript/src/check/`)

Barrel exports as declared at the end of each file.

- **`ast.ts`** — `nodeKind`, `asVarName`, `asPath`, `litOf`.
- **`builtin-rules.ts`** — `synthBuiltinCall`.
- **`builtin-types.ts`** — types: `TVarNode`, `BuiltinSig`, `BuiltinEntry`,
  `BuiltinTable`, `Bindings`.
- **`checker.ts`** — `buildTypeScope`, `synth`, `paramAt`, `checkArity`,
  `reportMismatch`, `check`.
- **`context.ts`** — types: `CheckContext`, `TypeEnv`, `Diagnostic`, `Severity`,
  `Sig`; values: `EMPTY_ENV`, `report`, `at`, `isBody`, `sigOf`,
  `bodyFnTypeSchema`, `bindingKeys`, `stableStringify`.
- **`module.ts`** — `checkFunction`, `checkModule`, `checkExpr`.
- **`narrowing.ts`** — `withNarrowings`, `factsFromCondition`, `currentType`,
  `restrictToLiteral`, `excludeLiteral`, `caseUniverse`.
- **`schema.ts`** — types: `Schema`, `Defs`, `ApMode`, `FnTypeShape`, `Bound`;
  values: `SchemaKind`, `isSchemaObject`, `classifySchema`, `asObject`,
  `refName`, `resolveRef`, `resolveDeep`, `unionArms`, `literalValues`,
  `deepEqual`, `itemsSchema`, `prefixItems`, `tupleRest`, `apMode`, `properties`,
  `requiredKeys`, `fnShape`, `valueType`, `typeMatches`, `unionOf`, `projectField`.
- **`subsumption.ts`** — `isSubschema`.
- **`values.ts`** — `valueSatisfies`.
