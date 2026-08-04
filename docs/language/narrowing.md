# Flow narrowing — reference

Status: **frozen.** This documents the narrowing the checker performs *today*.
It is a deliberately small, fixed set — it will not be extended. The reasoning
(see `plans/recenter-plan.md` §4): the language's primary authors are AI coding
agents, and deterministic, simple rules are easier for models to learn and stay
stable across model generations than a fuzzy "does the checker narrow through
this shape?" boundary. When a union in a local can't be discharged by one of the
forms below, the sanctioned escape hatches are checked assertions
(`x!` for nullability and `value checked as Type` for an explicit runtime contract),
not more narrowing.

Behavior lives in `typescript/src/check/narrowing.ts`; the control-flow wiring is
in `typescript/src/check/checker.ts` (the `$if` / `$cond` / `$match` cases). This
set is table-tested in `typescript/test/check/narrowing.test.ts`.

## Model

Narrowing is a **sound refinement**: a fact only ever *shrinks* a subject's type
within the branch it governs. It never widens, and an unrecognized condition
form yields **no fact** — the subject keeps its declared type and an unprovable
use is a hard `error`, never a silent pass. There is no "we couldn't tell, so
`any`" path here.

Facts are threaded into the child context of the arm they govern
(`ctx.narrowings`, keyed by the subject's canonical path). Sibling arms are
unaffected.

## Subjects

A fact is produced only when the narrowed subject is a **static access path**:

- a bare variable — `x` (`{"$var": "x"}`), or
- a chain of literal-string field reads rooted at a variable — `x.tag`,
  `move.from`, `x.a.b`.

Anything dynamic (a computed key, a numeric index, a call result, a non-variable
root) is not a subject and yields no fact.

The subject's declared type comes from a **parameter** or an **eager binding**
directly; a **lazy `where`-local** is narrowed at its forcing site when it
transitively references a narrowed subject (the free-variable–gated re-synth in
`checker.ts` / `buildTypeScope`).

## Recognized condition forms

Each form is evaluated on both the branch where the condition holds (the
*then* / matching-case sense) and where it doesn't (the *else* sense).

### 1. Truthiness

A subject used directly as a condition is known-truthy on the then-branch and
known-falsy on the else-branch (`docs/language/language.md` truthiness: `false`, `null`,
`0`, and `""` are falsy; everything else — including all arrays/objects — is
truthy).

- then: keep the truthy inhabitants. `T | null` ⇒ `T`; `boolean` ⇒ `true`; a
  number/string keeps its whole type (its single falsy value `0` / `""` is
  dropped).
- else: keep the falsy inhabitants. `T | null` else-branch keeps `null` (plus
  the falsy slice of `T`); `boolean` ⇒ `false`.

Splits that aren't exactly expressible widen back to the whole type rather than
under-approximate (soundness). Composites and functions are always truthy.

This is the `if x then x else 0` idiom, and it also applies to a bare
`where`-local used as a condition (see *named boolean guards* below).

A field-path condition whose base is a **union** is additionally a
*discriminant* (the truthiness analog of form 4): each branch keeps only the
arms whose `field` has any truthy (then) / falsy (else) inhabitants. This is
the boolean-discriminant idiom —
`if r.ok then r.output else r.error` narrows
`r : {ok: true, output: string} | {ok: false, error: string}` to the matching
arm on each branch. An arm whose `field` admits both (e.g. a plain `boolean`)
survives both branches; a non-union base yields no base fact (the path itself
still narrows as above).

### 2. Type predicates

The `isType` family — `isNull`, `isBool`, `isNumber`, `isInteger`, `isString`,
`isArray`, `isObject` — applied to a subject.

- then: intersect the subject schema with the tested runtime category. This is
  a real category intersection, not arm filtering: `any` becomes the tested
  category, and `number` becomes `integer` under `isInteger`. Compatible
  refinements and already-more-precise arms are retained.
- else: subtract the tested category where the remainder is representable.
  Constants and finite enums are filtered exactly; broad overlapping schemas
  stay unchanged when their remainder cannot be expressed.

`isInteger` follows this exact table:

| Subject | Then (`isInteger`) | Else (`not isInteger`) |
| --- | --- | --- |
| `any` | `integer` | `any` |
| `number` | `integer` | `number` |
| `integer` | `integer` | `never` |
| `string` | `never` | `string` |
| `number \| string` | `integer` | `number \| string` |
| `integer \| string` | `integer` | `string` |
| `1 \| 1.5 \| string` | `1` | `1.5 \| string` |

Keeping `number` on the false branch is intentional: the schema fragment has
no type for non-integral numbers, so `number - integer` cannot be represented.
The sound approximation is the original `number`, not an under-approximation
that could exclude valid fractional values.

`isNull(x)` on `T | null` ⇒ `null` (then) / `T` (else) is the canonical
guard-then-use case. `isNumber(x)` preserves an `integer` arm because it is
already more precise. For `x: number | string`, `isInteger(x)` gives `integer`
then and `number | string` else; for `x: integer | string`, it gives `integer`
then and `string` else.

A predicate name that is **shadowed** by a user binding of the same name is not
treated as a guard (runtime dispatch would pick the user value), so it yields no
fact.

### 3. Equality — literal pin / exclude

`eq(x, <lit>)` / `x == <lit>` (either argument order; `neq` / `!=` is the same
with the sense flipped), where `x` is a **bare-variable** subject:

- then: pin to `{const <lit>}` when the literal is admissible, else `never`.
- else: exclude the literal (enum/const membership surgery; a no-op for a
  subject with no finite literal set), with one category-exact exception:
  excluding `null` removes a primitive `null` arm from a union. Thus
  `x != null` narrows `T | null` to `T`.

### 4. Equality — discriminant (field path)

`eq(x.field, <lit>)` / `x.field == <lit>`, where the subject is a **field path**
whose base `x` is a union: this refines the *base* `x`.

- then: keep the union arms whose `field` admits `<lit>`.
- else: drop the arm whose `field` is *exactly* `{const <lit>}`. A singleton
  `enum` (`{enum: [<lit>]}`) is the same schema as a `const` and counts as
  exact.

`match s.tag { "a": …, "b": … }`-style tagged dispatch narrows `s` to the
matching arm in each case (see `$match` below).

### 5. `$match` subject

A `$match` narrows its subject per case, reusing the equality machinery:

- **bare-variable subject:** each literal case pins the subject to that literal
  (`restrictToLiteral`); `$else` sees every matched literal excluded
  (`excludeLiteral`).
- **discriminant-path subject** (`match s.tag { … }`): each literal case narrows
  the base `s` to the matching union arm; `$else` drops all matched arms.

(The finite-universe exhaustiveness / dead-case lints are separate `error`
diagnostics, not narrowing facts.)

## Composition

Recognized forms compose:

- **`not(g)` / `!g`** — recurse into `g` with the sense flipped.
- **`$and`** — learns a **conjunction** of its operands' facts, but only on the
  **true** sense (each operand's facts threaded forward, so a later operand can
  refine an earlier one on the same subject). `$and` on the false sense yields no
  sound single-subject fact.
- **`$or`** — the mirror: learns the conjunction of its operands' *negated*
  facts on the **false** sense only. `$or` on the true sense yields nothing.
- **Named boolean guards** — a bare-variable condition that names a
  `where`-local (`empty: isNull(target)` used as `cond { empty: … }`) recurses
  into the local's binding expression and adopts its facts. Alias chains are
  followed (`ok: not(empty)`, `empty: isNull(target)`) and are cycle-guarded. If
  the recursion produces no fact, the bare local falls back to its own
  **truthiness** (form 1) — this is why `if h then h else 0` narrows for a
  `where`-local, not only a parameter.

## Control-flow wiring

- **`$if`** — `$then` gets the condition's then-facts; `$else` gets its
  else-facts.
- **`$cond`** — arm *i* is reached only when every earlier condition was false,
  so it accumulates the negation of conditions `0..i-1` (dominating guards) plus
  its own positive fact; `$else` inherits every condition negated.
- **`$match`** — as in form 5 above.

## Non-goals (frozen — do not add)

- No narrowing on non-path subjects (call results, computed indices).
- No arithmetic / refinement inference (`Score = integer & min(0)` stays opaque
  to arithmetic). `x!` only removes `null`; use `expression checked as Score` when a
  computed result must be validated as a refinement.
- No single-subject fact from `$and`-false or `$or`-true.
- No loosening of callback arity — adapting a unary `g` to an indexed callback
  still requires the exact wrapper shape
  (`mapIndexed((x, _index) => g(x), xs)`).
- The lazy-local re-synth machinery may be simplified but not grown.
