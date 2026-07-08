# §5.5 Narrowing — implementation plan

Status: **plan / build order**. Scopes the single biggest remaining gap in the
typechecker (`typescript/src/check.ts`). Grounded in the current code, the
design sketch (`type-sketch.md` §5.5), and the empirically-confirmed wall in the
Tier-2 chess tests (`typescript/test/check.test.ts`). Decisions marked **[D]**;
open forks gathered at the end.

---

## 0. The wall, restated

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
positive fires. `check()` (`check.ts:1071`) and the builtin arg loop in
`applyOverload` (`check.ts:1243`) both run a bare `isSubschema(actual, expected)`
and push an **error** on failure — there is no notion of a runtime-checkable
mismatch.

The Tier-2 tests currently **pin this wall** rather than mask it
(`check.test.ts:848`): `pieceColor` asserts exactly one diagnostic with
`expected: string`, `actual: Cell`. Those assertions are the regression anchor —
each milestone below flips a specific one.

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

## Milestone 0 — `severity` + warning downgrade (§5.5 option 1) **[D — ship first]**

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

`report()` (`check.ts:684`) gains an optional severity (default `"error"`), so
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

The two comparison sites emit warnings instead of errors when
`narrowableMismatch` holds:

- `check()` (`check.ts:1078`).
- `applyOverload` arg check (`check.ts:1263`) and lambda-return check
  (`check.ts:1288`).

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

## Milestone 1 — flow narrowing for params & direct vars (§5.5 option 2, core)

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

The `"var"` case of `synth` (`check.ts:973`) consults `ctx.narrowings[name]`
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

In `synth`'s `if` / `cond` / `match` cases (`check.ts:1017`–`1041`), thread
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

## Milestone 2 — lazy-local narrowing at forcing sites (the hard part)

This is where the bulk of chess lives, and where the current architecture
actively fights us.

### 2.1 The memoization problem

`buildTypeScope` (`check.ts:742`) types an un-annotated local **once**, memoized
in `memo[name]`, synthesized under the *definition-time* `ctx`
(`synth(exprLocals[name]!, { ...ctx, env, path: [name] })`, `check.ts:778`).
Two consequences block narrowing:

1. The forcing-site's `ctx.narrowings` are **discarded** — resolution uses the
   captured build-time ctx, so a local forced inside `else (piece non-null)` is
   still typed with `piece : Cell`.
2. A single `memo` slot can't hold a local whose type **differs per arm** — and
   under narrowing it must (`type` in `pieceMoves` is only ever forced where
   `piece` is non-null, but nothing structurally forbids another forcing site).

So M2 is fundamentally a **`buildTypeScope` redesign**, not an additive hook.

### 2.2 Approach **[D — re-synth under facts, with a free-variable gate]**

- Split the memo: keep the existing single-slot memo as the **un-narrowed**
  type (fast path, unchanged behavior when no facts are active).
- Compute each local's **free variables** (the `$var` names it transitively
  references) once. When a local is forced under `ctx.narrowings`, check whether
  any narrowed name is free in it. If **not**, return the memoized un-narrowed
  type (the common case — cheap). If **yes**, **re-synth** the local under the
  active facts and cache keyed by the relevant fact subset.
- Cycle guard (`resolving`, `check.ts:764`) is preserved; the free-var pass is
  itself cycle-guarded and reuses the same dependency walk.

Re-synth cost is bounded by "locals that actually depend on a narrowed var,
under distinct fact sets" — small in practice (chess locals form shallow DAGs).

### 2.3 Narrowing through a named boolean guard

The `cond { !ok -> …, empty -> … }` idiom guards arms with **boolean locals**
(`empty: isNull(target)`), not inline predicates. To narrow `target` on the
`empty` arm we must see through the binding:

- Extend `factsFromCondition` so that when the condition is `$var b` and `b` is
  a local bound to a **recognized guard expression**, it expands to that
  expression's facts (`empty → isNull(target)`), then applies §1.2.
- Guard-expression detection reuses the M1 recognizer. Bounded expansion depth
  (a local may alias another boolean local); cycle-guarded.

This single addition unblocks `slideDir`, `steppingMoves`, `pawnMoves`,
`isLegalMove`, `hasAnyLegalMove`, and the `cond`-heavy layer.

### 2.4 Refinements attach to forcing, not binding (§5.5 point 3)

Falls out for free: because locals are typed (and, later, contract-checked) at
their **forcing site**, a computed-but-unused value (`slideDir`'s out-of-bounds
`tIdx`, `steppingMoves`'s `target` on the `!ok` arm) is never forced on the dead
branch, so its refinement contract never fires. No eager-contract false alarms.
Document that refinement enforcement (§2.6/§6) must hang off forcing, and keep
hot internal helpers (`toIdx`) loosely typed by design.

### 2.5 Tests

- `pieceMoves`: `isNull(piece)` (local) then `match`/arm uses of `type`/`color`
  → zero diagnostics.
- `slideDir` fragment: `cond` guarded by `empty`/`!ok` boolean locals → clean.
- `parseMove` (partial): `!isNull(from) && !isNull(to)` then `{from, to}` —
  clean for the var part (field access is M3).
- A per-arm divergence test: same local forced in two arms with different active
  facts yields two different types (proves the memo split).

---

## Milestone 3 — field-path & discriminant narrowing (stretch)

The tail: narrowing subjects that are **paths**, not bare vars.

- **Nullable field / element:** `isNull(move)` then `move.from`
  (`moveResult`) — narrow the path key `move` and let `$get` projection
  (`projectField`, `check.ts:880`) see the narrowed target.
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

## Cross-cutting

- **Soundness stance:** narrowing is a *sound refinement* (facts only ever
  shrink a type). When a guard form isn't recognized, we fall back to the M0
  warning path — never a silent pass. The system stays honest.
- **Perf:** the free-variable gate (§2.2) keeps the no-narrowing path identical
  to today; re-synth is opt-in per dependent local. Watch the `checkModule`
  chess run for regressions.
- **Interaction with the builtin layer:** facts live on `CheckContext`, so they
  flow into `applyOverload`/`inferLambdaReturn` (`check.ts:1200`) unchanged —
  a narrowed var used as a builtin arg is already narrowed at `synth` time.
- **Coinductive `seen` set** (subsumes) is orthogonal; narrowing ops produce
  plain schemas that re-enter `subsumes` normally.

## Suggested order & exit criteria

1. **M0** — `severity` + warning downgrade. *Exit:* chess piece/parse layer has
   zero **errors**; Tier-2 tests assert warnings. Ships independently, unblocks
   §6 runtime work.
2. **M1** — param/var narrowing. *Exit:* `pieceColor`/`pieceGlyph` fully clean.
3. **M2** — lazy-local + boolean-guard narrowing (the `buildTypeScope`
   redesign). *Exit:* `pieceMoves`, `slideDir`, `isLegalMove` clean; per-arm
   divergence test passes.
4. **M3** — field-path / discriminant narrowing + §5.6 exhaustiveness together.
   *Exit:* `moveResult`/`parseMove` clean end to end.

## Open forks

1. **M0 vs. M1 as the true "next step".** M0 is unconditionally worth shipping
   (it's the §6 prerequisite and needs the `severity` field either way). The
   real fork is whether M1 lands *before* revisiting the runtime side, or the
   project banks M0 and pivots to §6/H. Recommendation: **M0 now, then M1**, since
   M1 is small once facts exist and turns the marquee `pieceColor` idiom green.
2. **Assertion operator (open Q9)** — blocks the "silence a warning explicitly"
   ergonomic; needs a syntax/AST decision before the checker hook.
3. **Memo strategy in M2** — re-synth-under-facts (recommended) vs. a
   fact-keyed memo cache. Decide when M2 starts, informed by measured re-synth
   counts on chess.
4. **Boolean-guard alias depth** — how far to chase `b: someOtherBool` chains
   before giving up to the M0 warning. Start at depth 1–2.
