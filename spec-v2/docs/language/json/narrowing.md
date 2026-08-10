# Flow narrowing

The checker narrows types only for the forms defined here. Other conditions
produce no narrowing fact. Use `x!` to exclude `null`, or
`value checked as Type` to validate and establish an explicit type.

## Model

Narrowing only removes possibilities from a subject's type within the branch
governed by the fact. Sibling branches are unaffected. If a use remains
unprovable, checking fails rather than widening the subject to `any`.

## Subjects

A fact is produced only when the narrowed subject is a **static access path**:

- a bare variable — `x` (`{"$var": "x"}`), or
- a chain of literal-string field reads rooted at a variable — `x.tag`,
  `move.from`, `x.a.b`.

Anything dynamic (a computed key, a numeric index, a call result, a non-variable
root) is not a subject and yields no fact.

A local binding that transitively references a narrowed subject is checked
using the facts at the point where that binding is used.

## Recognized condition forms

Each form is evaluated on both the branch where the condition holds (the
*then* / matching-case sense) and where it doesn't (the *else* sense).

### 1. Boolean subject

A subject used directly as a condition — necessarily boolean-typed, since
conditions are [boolean positions](expressions.md#boolean-positions) — is
`true` in the then branch and `false` in the else branch.

- then: `boolean` ⇒ `true`; the literal type `false` ⇒ `never`.
- else: `boolean` ⇒ `false`; the literal type `true` ⇒ `never`.

On the boolean domain this split is a partition: both branch types are
**exact**, and no widening clause is needed.

This also applies to a bare local binding used as a condition.

A field-path condition whose base is a union is also a
*discriminant* (the boolean analog of form 4): each branch keeps only the
arms whose `field` admits `true` (then) / `false` (else). This is
the boolean-discriminant idiom —
`if r.ok then r.output else r.error` narrows
`r : {ok: true, output: string} | {ok: false, error: string}` to the matching
arm on each branch. An arm whose `field` is a plain `boolean`
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

`isInteger` produces these then/else types:

- `any` → `integer` / `any`
- `number` → `integer` / `number`
- `integer` → `integer` / `never`
- `string` → `never` / `string`
- `number | string` → `integer` / `number | string`
- `integer | string` → `integer` / `string`
- `1 | 1.5 | string` → `1` / `1.5 | string`

The false branch of `number` remains `number` because the schema language
cannot express non-integral numbers.

`isNull(x)` on `T | null` gives `null` in the then branch and `T` in the else
branch. `isNumber(x)` preserves an `integer` arm because it is
already more precise. For `x: number | string`, `isInteger(x)` gives `integer`
then and `number | string` else; for `x: integer | string`, it gives `integer`
then and `string` else.

A predicate name shadowed by another binding is not treated as a guard.

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

- **bare-variable subject:** each literal case pins the subject to that
  literal; `$else` excludes every matched literal.
- **discriminant-path subject** (`match s.tag { … }`): each literal case narrows
  the base `s` to the matching union arm; `$else` drops all matched arms.

Finite-universe exhaustiveness and unreachable-case errors are separate from
narrowing.

### 6. Key presence — `hasKey`

`hasKey(x, "lit")`, where `x` is a path subject (the same paths as form 4) and
the key is a **literal** string:

- then: an optional field `k?: T` on the subject's type becomes present
  (`k: T`), so a bare read of `x.k` typechecks (see
  [property-access checking](expressions.md#checking-reads)).
- else: on a **closed** object type, the field is known absent and is removed
  from the type; on open objects and maps, no fact.

A non-literal key or a non-path subject yields no fact.

```
if hasKey(config, "retries")
then config.retries      // retries?: integer, narrowed present: integer
else defaultRetries
```

## Composition

Recognized forms compose:

- **`not(g)` / `!g`** — recurse into `g` with the sense flipped.
- **`$and`** — learns a **conjunction** of its operands' facts, but only on the
  **true** sense (each operand's facts threaded forward, so a later operand can
  refine an earlier one on the same subject). `$and` on the false sense yields no
  sound single-subject fact.
- **`$or`** — the mirror: learns the conjunction of its operands' *negated*
  facts on the **false** sense only. `$or` on the true sense yields nothing.
- **Named boolean guards** — a bare-variable condition naming a local binding
  adopts facts from that binding's expression. Alias chains are followed and
  cycle-checked. If the expression produces no fact, the local is narrowed as
  a boolean subject (form 1).

## Control-flow wiring

- **`$if`** — `$then` gets the condition's then-facts; `$else` gets its
  else-facts.
- **`$cond`** — arm *i* is reached only when every earlier condition was false,
  so it accumulates the negation of conditions `0..i-1` (dominating guards) plus
  its own positive fact; `$else` inherits every condition negated.
- **`$match`** — as in form 5 above.

## Limits

- No narrowing on non-path subjects (call results, computed indices).
- No `hasKey` fact from a non-literal key.
- No arithmetic / refinement inference (`Score = integer & min(0)` stays opaque
  to arithmetic). `x!` only removes `null`; use `expression checked as Score` when a
  computed result must be validated as a refinement.
- No single-subject fact from `$and`-false or `$or`-true.
- Callback arity remains exact. Adapting unary `g` to an indexed callback
  requires a wrapper such as `mapIndexed((x, _index) => g(x), xs)`.
