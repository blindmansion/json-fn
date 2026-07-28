# Writing json-fn

How to author json-fn programs in `.jfn` shorthand. This covers the complete
language surface — syntax and semantics only. The available builtins, and any
named types or `effects` vocabulary injected into your environment, are
described by separate context (in this repository, `docs/builtins.md`); this
doc is incomplete without it. Look builtins up there rather than guessing —
even familiar names can differ from their JS/Python counterparts in arity or
argument order.

## 1. Mental model

json-fn is a **pure functional expression language over immutable JSON
values**. The surface reads like TypeScript expressions with Haskell-flavored
`where` and `do`; this doc spends most of its words on where behavior diverges
from what those languages would suggest.

- The value universe is exactly JSON: `null`, booleans, finite float64
  numbers, strings, arrays, objects. There is **no `undefined`, no
  `NaN`/`Infinity`, no reference identity, and no mutation** — "updating" data
  means building new data.
- A `.jfn` file is one **module**: newline-separated `name: expression`
  bindings and `type Name = …` declarations. No imports or exports; one module
  per program. Some named function serves as the entry point (chosen by the
  environment, not by the module).
- **Everything is an expression.** There are no statements, blocks, loops,
  early returns, or `try`/`catch`. Iteration is builtins/higher-order
  functions plus recursion. Failure is either a hard evaluation error or the
  handleable `raise` effect (§12).
- Name lookup is lexical-first, then the builtin registry: parameters and
  locals shadow module bindings, which shadow same-named builtins.
- Comments: `// line` and `/* block */`.

## 2. A complete module

Most syntax below should be recognizable; the rest of the doc pins down the
semantics.

```jfn
// A small ledger: fold transactions over a map of accounts.
type Cents = integer & min(0) // refinement, not intersection
type Id = string & pattern("^acc_")
type Account = { id: Id, name: string, balance: Cents } // closed: extra keys invalid
type Ledger = { [string]: Account } // map type

type Tx = // discriminated union
    { tag: "open", id: Id, name: string }
  | { tag: "deposit", to: Id, amount: Cents }
  | { tag: "withdraw", from: Id, amount: Cents }

type Books = { ledger: Ledger, log: string[] }

// Named functions carry full signatures: every param annotated + return type.
balanceOf: (led: Ledger, id: Id) -> Cents =>
  if hasKey(led, id) then led[id].balance else 0

// Object-pattern parameter destructuring one positional object argument.
canDebit: ({ led, id, amount }: { led: Ledger, id: Id, amount: Cents }) -> boolean =>
  hasKey(led, id) && balanceOf(led, id) >= amount

note: (books: Books, msg: string) -> Books =>
  { ledger: books.ledger, log: concat(books.log, [msg]) }

// The body is a data object — `{…}` after `=>` is always data, never a block.
put: (books: Books, acct: Account, msg: string) -> Books => {
  ledger: merge(books.ledger, fromEntries([[acct.id, acct]])),
  log: concat(books.log, [msg])
}

// `where` locals come after the result, and are lazy — not a statement list.
// Arithmetic on a refined type yields plain integer; `checked as` re-validates.
adjust: (books: Books, id: Id, delta: integer, msg: string) -> Books =>
  put(books, merge(acct, { balance: acct.balance + delta }) checked as Account, msg) where {
    acct: books.ledger[id]
  }

// `match` on the tag narrows `tx` per arm; `else` is required.
apply: (books: Books, tx: Tx) -> Books => match tx.tag {
  "open": if hasKey(books.ledger, tx.id)
    then note(books, `skip: ${tx.id} already open`)
    else put(books, { id: tx.id, name: tx.name, balance: 0 }, `open ${tx.name}`),
  "deposit": adjust(books, tx.to, tx.amount, `+${str(tx.amount)} -> ${tx.to}`),
  else: cond {
    canDebit({ led: books.ledger, id: tx.from, amount: tx.amount }):
      adjust(books, tx.from, -tx.amount, `-${str(tx.amount)} <- ${tx.from}`),
    else: note(books, `decline: ${tx.from} lacks ${str(tx.amount)}`)
  }
}

// HOFs take the callback first, data last. Inline lambdas stay unannotated.
run: (txns: Tx[]) -> Books =>
  reduce((books, tx) => apply(books, tx), { ledger: {}, log: [] }, txns)

demo: () -> { names: string[], log: string } => {
  names, // punning: { names } == { names: names }
  log: join(final.log, "\n")
} where {
  final: run([
    { tag: "open", id: "acc_ada", name: "Ada" },
    { tag: "deposit", to: "acc_ada", amount: 100 },
    { tag: "withdraw", from: "acc_ada", amount: 250 }
  ]),
  names: map((a) => a.name, sortBy((a) => a.name, values(final.ledger)))
}
```

## 3. Modules

- One binding per line; a declaration ends where its expression is complete,
  so multi-line expressions are fine. No commas between top-level bindings and
  no two bindings on one line.
- Constants and functions are both plain `name: expression` bindings. All
  module names are visible everywhere in the file — bindings are lazy,
  memoized, order-independent, mutually recursive, and cycle-checked. There is
  no definition-order concern and no forward-declaration problem.
- A module binding shadows a same-named builtin. One nuance: only a binding
  whose value is *literally* a function (`f: (x) => …`) is callable as `f(x)`.
  A constant that merely *evaluates* to a function shadows the name as a
  value but not in call position — call it through an expression instead:
  `(theFn)(x)`.
- **Named functions must be fully typed** — this applies to module bindings
  and `where`-locals whose value is a function literal. Inline lambdas passed
  to higher-order functions must stay *bare*; the call site types them
  contextually.
- Functions are values: pass a function by its bare name (`map(double, xs)`)
  or explicitly with `&double`. `&(expr)` forces an evaluated reference.

## 4. Values and data literals

- Scalar literals are JSON: `42`, `-3.5`, `"text"`, `true`, `false`, `null`.
- **Arrays** evaluate their elements: `[1, f(x)]`. Spread splices arrays:
  `[first, ...middle, last]` — the spread operand must be an array.
- **Data objects** `{ key: value }`: keys are literal (bare identifiers or
  quoted strings), values are evaluated. Entries:
  - punning: `{ year }` means `{ year: year }` (bare identifier keys only);
  - spread: `{ ...defaults, retries: 5 }` — shallow merge, later entries win;
  - computed keys: `{ [keyExpr]: value }` — the key must evaluate to a string.
- A bare `{…}` is **always a data object, never a code block** — including
  immediately after `=>`. There are no blocks in the language.
- `$`-prefixed keys are forbidden in object literals (they collide with the
  language's internal encoding). To produce data that contains `$`-keys, use
  `raw <strict JSON>`: a verbatim island in which nothing is evaluated and
  ordinary JSON syntax (quoted keys) applies. You rarely need it.
- Call arguments can also be spread: `f(a, ...rest, b)`, `add(...pair)`.
  (Spread calls currently degrade the checker's knowledge of the result type
  to `any`; add `checked as T` when the result type matters.)

## 5. Operators and expressions

Closed operator set, highest to lowest precedence. Everything else is a named
builtin call.

| Prec | Operators            | Meaning                                        |
| ---- | -------------------- | ---------------------------------------------- |
| 0    | `x!` (postfix)       | non-null assertion (error if `null`)           |
| 1    | `!x` `-x`            | logical not, numeric negation                  |
| 2    | `*` `/` `%`          | float64 arithmetic                             |
| 3    | `+` `-` `++`         | numeric add/sub; `++` is string concatenation  |
| 4    | `==` `!=` `<` `<=` `>` `>=` | comparisons; ordered ones chain         |
| 5    | `&&`                 | short-circuit and, returns the deciding value  |
| 6    | `\|\|`               | short-circuit or, returns the deciding value   |
| 7    | `expr checked as T`  | runtime-validated type ascription              |

Semantics to internalize:

- **No coercion anywhere.** `+` is numeric only; concatenate strings with `++`
  or templates. `==`/`!=` is **deep structural equality** — the only equality
  the language has — and does not coerce (`1 == "1"` is `false`,
  `[1, {a: 2}] == [1, {a: 2}]` is `true`). There is no `===`.
- **Comparison chaining is real:** `0 <= x < 100` means what it looks like,
  evaluating each operand once, left to right, stopping at the first failure.
  Equality operators cannot participate in chains.
- **Truthiness:** exactly `false`, `null`, `0`, and `""` are falsy.
  **Empty arrays and objects are truthy** (JS-like, not Python-like).
- `&&`/`||` return the first falsy / first truthy operand's value, like JS.
  They are the *only* lazy boolean forms; the builtins `and`/`or` are eager
  functions.
- Arithmetic that would produce `NaN` or `±Infinity` **errors** instead
  (`1 / 0` is an error). `/` is float division: `7 / 2` is `3.5`.
- `x!` asserts non-null: returns any non-`null` value unchanged, errors on
  `null`, and strips `null` from the static type.
- `expr checked as T` evaluates once, validates the result against `T` at
  runtime, and gives the expression exactly type `T`. It is an **assertion,
  not a conversion** (`"1" checked as integer` fails). Lowest precedence
  (`a + b checked as Cents` checks the sum) and non-associative.
- **Template strings** `` `total: ${str(n)}` ``: interpolation is **strict** —
  each `${…}` must produce a string; wrap numbers and anything else
  explicitly (`str(n)`). Escapes: `` \` ``, `\${`, plus normal JSON escapes.

## 6. Functions

```jfn
(a, b) => a + b // bare lambda (contextually typed at HOF call sites)
(a: number, b: number) -> number => a + b // fully typed
```

Signatures are **all-or-nothing**: annotate every parameter and the return
type, or nothing.

### Parameters

```jfn
greet: (name: string, title?: string, punct: string = "!") -> string =>
  if isNull(title) then `hi ${name}${punct}` else `hi ${title} ${name}${punct}`
```

- Required parameters come first, then any mix of optional (`x?`) and
  defaulted (`x = expr`), then at most one rest parameter (`...rest`), which
  arrives as an array (possibly empty). `?` and `=` cannot combine.
- **Omitting an optional parameter binds `null`** — there is no `undefined`.
  Its local type is `T | null`.
- Defaults are **lazy** and resolve in the whole invocation scope (they may
  reference other parameters regardless of order — not JS's left-to-right
  rule). **An explicit `null` argument is supplied data: it binds `null` and
  suppresses the default.** Note the annotation on an omittable parameter
  types the *supplied* value, so the checker rejects an explicit `null` for
  `title?: string` — omit the argument instead (or annotate `string | null`
  if callers should pass `null` deliberately).
- Because calls are positional and cannot skip a slot, an omittable parameter
  followed by another parameter can no longer be omitted when the later one is
  supplied. Rule of thumb: **at most one trailing omittable positional
  parameter**; a function with several independent optional knobs should take
  one object-pattern argument instead (`({ b = "B", c? }) => …`), whose fields
  omit independently.
- **Arity is exact.** Calls must supply every required slot and may not exceed
  the fixed slots unless there is a rest parameter — extra arguments are
  errors, not ignored.
- **Object patterns** destructure one positional object argument:
  `({ from, to, label = "" }) => …`. The calling convention is unchanged —
  the caller passes one plain object (`move({ from: 1, to: 3 })`); required
  fields must be present, extra keys are ignored, absent optional/defaulted
  fields behave like optional/defaulted parameters. The pattern slot itself is
  always required. No renames or nested patterns.

### Callback shape discipline

Because arity is exact, callback shapes must match the HOF **exactly**.
Ordinary array HOFs supply only the item (`reduce` supplies accumulator and
item); their `*Indexed` variants additionally supply the integer index.

```jfn
map((x) => x * 2, xs) // item only
mapIndexed((x, i) => x * i, xs) // need the index? use the *Indexed HOF
mapIndexed((x, _index) => f(x), xs) // ignored params still must be declared
```

Higher-order builtins take the **callback first and the data last**:
`map(f, xs)`, `filter(f, xs)`, `reduce(f, init, xs)`.

### Closures and recursion

Returning a lambda closes over outer variables; curried application works
(`makeAdder(2)(40)`), and an access chain in call position is an evaluated
callee (`handlers.onMove(x)`, `caps[name](x)`). Closures are self-contained
serializable values.

```jfn
makeAdder: (x: number) -> (number) -> number => (y) => x + y
```

Functions recurse by name — a module function by its module name, a
`where`-local function by its local name; mutual recursion works in both.
Recursion is the loop; environments may meter total work, so prefer builtins
(`map`, `reduce`, `range(n)`/`rangeFrom(lo, hi)`, …) over manual recursion
when one fits.

## 7. `where` — local bindings

```jfn
summary: (xs: number[]) -> string =>
  `${str(n)} item(s), sum ${str(total)}` where {
    n: length(xs),
    total: reduce((a, x) => a + x, 0, xs)
  }
```

- The **result expression comes first**; locals follow in the `where` block.
- Bindings are a **lazy, memoized dependency graph — not a statement
  sequence**. Order is irrelevant, bindings may reference each other and
  recurse mutually, cycles are runtime errors when actually forced, and a
  binding never demanded from the result **never evaluates** (so a `tap(…)`
  logging call parked in an unused binding does nothing).
- Every binding must be reachable from the result (directly or through other
  bindings) — unused bindings are checker errors, not dead code.
- Function-valued `where` bindings are named functions: they need full
  signatures and are callable (and recursive) by their local name.
- An unparenthesized `where` attaches to the largest enclosing expression
  within the current binding or arm — after an `if`/`cond`/`match` it scopes
  over the whole conditional, while inside a `cond`/`match` arm it stops at
  that arm. Parenthesize a branch to scope locals to just that branch:
  `if p then x else (fix(x) where { fix: … })`.
- Inner `where` names shadow parameters and outer bindings.

## 8. Control flow

All control flow is expression-valued and lazy (only the taken branch
evaluates):

```jfn
if x > 0 then "pos" else "non-pos" // else is mandatory

cond { // first truthy arm wins
  n < 0: "negative",
  n == 0: "zero",
  else: "positive" // optional, but falling off the end errors
}

match cmd { // subject compared by equality
  "show": render(state),
  "reset": initial(),
  else: help() // else is REQUIRED
}
```

`match` subjects and case values must be **scalars** (`null`, boolean, number,
string) — no array/object cases, no patterns, no guards. Use `cond` for
arbitrary conditions. There are no loops; see §6 on recursion and HOFs.

## 9. Property access

```jfn
user.name        cells[0]        row[i]        config["retry-count"]
```

- A **missing** object key or out-of-range index reads as `null`. But reading
  *through* a present `null` errors (`a.b.c` when `a.b` is `null`), as does
  accessing a non-container. There is no `?.` — guard with `if`/`isNull`, or
  assert with `!` when you know better than the type
  (`first: (xs: integer[]) -> integer => xs[0]!`).
- Keys are never coerced: arrays and strings require integer indices, objects
  require string keys. Index an object by a number's string form explicitly:
  `obj[str(n)]`.
- String indexing, `length`, and slicing count **Unicode code points**, not
  UTF-16 units (`"a😀b"[1]` is `"😀"`, length `3`).
- There is no assignment. Build updated data with expressions — typically
  `merge(obj, { field: newValue })`, `concat(xs, [x])`, spread literals
  (`{ ...obj, field: v }`), or `entries`/`fromEntries` pipelines. Adding a
  *new* field this way yields a wider shape than the original closed object
  type — declare that wider shape as its own type.

## 10. Types

Types appear in exactly four places: module `type` declarations, function
signatures, `handle … returns T with` (§12), and `expr checked as T`. There
are **no local variable annotations** — locals infer.

```jfn
type Status = "active" | "inactive" | "banned" // literal unions
type Point = [number, number] // tuple
type Path = Point[] // array
type Labels = { [string]: string } // map: string keys, uniform values
type Maybe = string | null // nullability is explicit
type User = { id: string, score?: integer } // ? = optional field
type Loose = { id: string, ... } // ... opens the object
type Tree = { value: number, children: Tree[] } // recursion ok through arrays/objects
type Guard = (Account) -> boolean // function type
```

- Primitives: `null boolean number integer string`, plus `any` and `never`.
  `integer` is a distinct primitive.
- **Object types are closed by default**: a value with extra keys fails
  validation. Append `...` to allow extra keys. (Opposite instinct from
  TypeScript's structural excess tolerance.)
- **`&` is refinement, not intersection.** It attaches validation to a
  matching base and rejects mismatched combinations: `min(n)`/`max(n)`/
  `xmin`/`xmax`/`multipleOf` on numbers, `minLen`/`maxLen`/`pattern(re)`/
  `format(name)` on strings, `minItems`/`maxItems`/`unique` on arrays.
  E.g. `integer & min(0) & max(100)`.
- Refinements are **opaque to arithmetic**: adding to a `Cents` yields plain
  `integer`. Re-establish the refinement explicitly with
  `expr checked as Cents`. Types are runtime validators too — that is what
  `checked as` runs.
- Function types: `(A, B?) -> R`, rest as `(A, ...B[]) -> R`. **Optionality is
  argument-count, not nullability**: `(A?) -> R` takes zero or one argument;
  `(A | null) -> R` takes exactly one, possibly-null argument. The return type
  extends right (`(A) -> B | C` returns `B | C`); parenthesize a function type
  used as a union arm or element: `((Event) -> Result) | null`.
- Discriminated unions are just unions of closed objects sharing a literal
  `tag` field — no special syntax; `match`/`==` on the tag narrows (§11).
- **No user-defined generics.** The single built-in type constructor is
  `Task<A>` (§12); builtins are internally polymorphic. The name `Task` is
  reserved — a module `type` cannot redeclare it.
- Non-contractive recursion (`type A = A | null`) is an error; recursion must
  pass through an array or object constructor.

## 11. Narrowing

Narrowing is a deliberately **small, frozen set** — do not expect TypeScript
flow analysis. When a union won't discharge with the forms below, the
sanctioned escape hatches are `x!` (nullability) and `expr checked as T`
(explicit runtime contract) — not cleverer conditions.

Subjects must be **static paths**: a bare variable (`x`) or literal field
reads rooted at one (`tx.tag`, `state.board.turn`). Call results and computed
indices never narrow.

Recognized forms (each narrows the taken branch and its inverse narrows the
other):

1. **Truthiness** — `if x then … else …` drops `null` (and `false`) on the
   then-branch; a truthy check on `r.ok` selects matching arms of a union `r`.
2. **Type predicates** — `isNull`, `isBool`, `isNumber`, `isInteger`,
   `isString`, `isArray`, `isObject` applied to a subject.
3. **Literal equality** — `x == "a"` pins, `x != "a"` excludes; `x != null`
   narrows `T | null` to `T`.
4. **Discriminants** — `tx.tag == "open"` (or `match tx.tag { … }`) selects
   the union arms of `tx` whose tag admits the literal, per arm/case, with
   `else` seeing the rest.

These compose through `!`, `&&` (facts flow into the true branch), `||`
(negated facts into the false branch), and named boolean `where`-locals used
as conditions (`cond { empty: …, … } where { empty: isNull(target) }`).
`cond` arms narrow like a chain of `if`s: each arm sees its condition's
facts, and later arms (and `else`) see their inverses.

## 12. Tasks and effects

json-fn is pure: evaluating an expression never performs I/O. Effects are
**inert data** — values called **tasks** that *describe* an effectful step.
Building a task does nothing; the surrounding environment (or an in-language
handler) runs it. `Task<A>` types a task whose eventual completion value is
`A`.

Constructors (all pure):

- `effects.some.name(args…)` — the typed effect namespace injected by your
  environment (its vocabulary is part of your task context). Calling a leaf
  builds an effect task; it does not perform anything. Because the
  environment injects `effects`, a module may not bind that name at top
  level.
- `pure(v)` — a completed task carrying `v`.
- `raise(err)` — the error channel: a distinguished effect an enclosing
  handler (or the environment) can intercept. There is no throw/catch.
- Low-level `perform(name, args)` and `bind(task, k)` exist beneath the sugar;
  you normally won't write them, but printed-back code may show `bind`.

### `do` notation

```jfn
tick: (st: State) -> Task<State> => do {
  reading <- effects.sensor.read(), // run the task, bind its result
  action: decide(st, reading), // ':' is a lazy pure local — it does NOT run anything
  effects.log(describe(action)), // bare non-final entry: run, discard result
  pure(apply(st, action)) // final entry is the block's result
}
```

- **`name <- taskExpr` is the only entry that runs a task and binds its
  result.** `name: taskExpr` merely binds the task *value* (lazily, with
  `where`-binding semantics) — a classic mistake is writing `:` and wondering
  why the effect never happens.
- A `do` block must end with an expression (usually `pure(result)` or a final
  task call), never a binding.
- Write `<-` with the two characters adjacent (`< -` is a comparison against
  a negation).
- Purely computational code needs no tasks at all; only produce a task (via
  `pure` if nothing effectful happens) when a `Task<…>` result is required.

### `handle` — interpreting effects in-language

`handle` runs a task and dispatches each effect it performs to a clause —
a pure interpreter, which is how effectful code gets tested with mocks:

```jfn
testGreeting: () -> string =>
  handle greet() returns string with {
    "io.readLine": (resume) => resume("world"), // effect args…, then resume
    "io.print": (msg, resume) => resume(null)
  }
```

- Clause keys are the effect names as data-object keys (dotted names, `"*"`,
  and `"return"` must be quoted). A named clause receives the effect's
  arguments positionally, then a `resume` continuation last; call
  `resume(value)` to answer the effect and continue the task.
- `"*"` catches any unmatched effect as `(eff, resume) => …` with
  `eff = { name, args }`. `"return"` post-processes the task's normal
  completion value.
- `handle task returns T with { … }` is the **total** form: its result is
  validated as `T` and an unmatched effect is an error. Without `returns T`,
  the handler is **partial**: unmatched effects bubble outward to the next
  enclosing `handle`, and ultimately to the environment.
- `resume` is an ordinary value: store it, or call it **more than once** —
  multi-shot resumption is the basis for retry/backtracking combinators.

## 13. Trip-up checklist

Coming from JS/TS:

- `{…}` after `=>` is a **data object, never a block**; there are no
  statements, loops, `return`, or `try`/`catch` anywhere.
- `where` is a **lazy dependency graph**, not sequential `const`s; unused
  bindings are checker errors and never evaluate.
- **Exact arity**: extra call arguments are errors. `map`/`filter` callbacks
  take the item only — use `mapIndexed((x, _index) => …)` etc. when you need
  (or must declare) the index. Callback first, data last: `map(f, xs)`.
- `==` is deep **structural** equality, no coercion, no `===`.
- `+` never concatenates. Strings use `++` or templates, and `${…}` requires
  strings — write `${str(n)}`.
- Omitted optional params/fields bind **`null`** (no `undefined`); an explicit
  `null` argument **suppresses the default** and must be permitted by the
  annotation — you cannot pass `null` to "skip" a middle optional slot. Give a
  function with several optional knobs one object-pattern argument instead.
- Missing keys read as `null`, but reading **through** `null` errors; there is
  no `?.` — guard, or assert with `!`.
- Object **types** are closed by default; add `...` to tolerate extra keys.
  `&` in types is refinement, not intersection.
- Narrowing is a fixed small set (§11); escape with `x!` or `checked as`.
- Errors: evaluation errors halt; recoverable failure is `raise` + `handle`.
- String positions count **code points**, not UTF-16 units.
- `/` is float division; arithmetic that would produce `NaN`/`Infinity`
  errors instead (including `1 / 0`).

Coming from Python/Haskell:

- Empty `[]` / `{}` are **truthy**; only `false`, `null`, `0`, `""` are falsy.
- In `do`, only `<-` runs a task; `:` entries are lazy pure locals.
- No pattern matching beyond scalar `match` subjects and object-pattern
  parameters; no list comprehensions — use HOFs.

And json-fn specifics with no analogue elsewhere:

- Named functions (module and `where`-local) **must be fully typed**; inline
  HOF lambdas must stay bare.
- Refinements are opaque to arithmetic — revalidate computed values with
  `checked as`.
- Comparison chaining (`0 <= x < 100`) works and evaluates operands once.
- Two names are reserved: `Task` as a `type` name and `effects` as a
  top-level binding.
- `$`-prefixed keys are forbidden in object literals; wrap such data in
  `raw { … }` (strict JSON inside).
