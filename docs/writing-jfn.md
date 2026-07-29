# Writing json-fn

How to author json-fn programs in `.jfn` shorthand. This covers the complete
language surface — syntax and semantics only. Builtin signatures, and any named
types or `effects` vocabulary injected into your environment, are described by
separate context.

## 1. Mental model

json-fn is a **pure functional expression language over immutable JSON
values**. The surface reads like TypeScript expressions with Haskell-flavored
`where` and `do`.

- The value universe is exactly JSON: `null`, booleans, finite float64
  numbers, strings, arrays, objects. There is **no `undefined`, no
  `NaN`/`Infinity`, no reference identity, and no mutation**.
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

```jfn
// A small ledger: fold transactions over a map of accounts.
type Cents = integer & min(0) // refinement, not intersection
type Id = string & pattern("^acc_")
// Refine boundary/input values freely, but default recomputed fields to plain
// types: refinements are opaque to arithmetic, so a refined balance would
// require `checked as` at every write. Refine a derived field only when its
// invariant must fail at the construction site, before any later boundary;
// `checked as` failures are hard errors, so valid-input failures use cond/raise.
type Account = { id: Id, name: string, balance: integer } // closed: extra keys invalid
type Ledger = { [string]: Account } // map type

type Tx = // discriminated union
    { tag: "open", id: Id, name: string }
  | { tag: "deposit", to: Id, amount: Cents }
  | { tag: "withdraw", from: Id, amount: Cents }

type Books = { ledger: Ledger, log: string[] }

// Named functions carry full signatures: every param annotated + return type.
balanceOf: (led: Ledger, id: Id) -> integer =>
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
adjust: (books: Books, id: Id, delta: integer, msg: string) -> Books =>
  put(books, merge(acct, { balance: acct.balance + delta }), msg) where {
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
  whose value is _literally_ a function (`f: (x) => …`) is callable as `f(x)`.
  A constant that merely _evaluates_ to a function shadows the name as a
  value but not in call position — call it through an expression instead:
  `(theFn)(x)`.
- **Named functions must be fully typed** — this applies to module bindings
  and `where`-locals whose value is a function literal. Inline lambdas passed
  to higher-order functions must stay _bare_; the call site types them
  contextually.
- Functions are values: pass a function by its bare name (`map(double, xs)`)
  or explicitly with `&double`. `&(expr)` forces an evaluated reference.
- If the module is linked against an environment contract, the contract's
  `$defs` are injected as type names (as is `effects`); do not re-declare
  them — declare only module-internal types.

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

| Prec | Operators                   | Meaning                                       |
| ---- | --------------------------- | --------------------------------------------- |
| 0    | `x!` (postfix)              | non-null assertion (error if `null`)          |
| 1    | `!x` `-x`                   | logical not, numeric negation                 |
| 2    | `*` `/` `%`                 | float64 arithmetic                            |
| 3    | `+` `-` `++`                | numeric add/sub; `++` is string concatenation |
| 4    | `==` `!=` `<` `<=` `>` `>=` | comparisons; ordered ones chain               |
| 5    | `&&`                        | short-circuit and, returns the deciding value |
| 6    | `\|\|`                      | short-circuit or, returns the deciding value  |
| 7    | `expr checked as T`         | runtime-validated type ascription             |

The semantics fit in a few live expressions:

```jfn
{
  noCoercion: 1 == "1",                    // false; there is no `===`
  deepEquality: [1, { a: 2 }] == [1, { a: 2 }], // true: equality is structural
  inRange: 0 <= x < 100,                   // real chain; each operand runs once
  emptyIsTruthy: [] && "yes",              // "yes"; only false/null/0/"" are falsy
  fallback: value || "default",            // &&/|| are lazy and return operand values
  quotient: 7 / 2,                         // 3.5; 1 / 0 errors (no NaN/Infinity)
  required: maybe!,                        // errors on null; statically strips null
  cents: total + fee checked as Cents,     // validates the whole sum once
  label: `total: ${str(total)}`             // interpolation requires a string
} where {
  x: 42, value: "", maybe: 3, total: 10, fee: 2
}
```

`+` is numeric only; concatenate strings with `++` or a template. `&&`/`||`
are the only lazy boolean operators (`and`/`or` are eager builtins). A
`checked as` is an assertion, not a conversion (`"1" checked as integer`
fails), and is non-associative. Template escapes are `` \` ``, `\${`, plus
normal JSON escapes.

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

// greet("Ada")                   => "hi Ada!": omitted title binds null
// greet("Ada", "Dr.")            => "hi Dr. Ada!"
// greet("Ada", "Dr.", "?")       => "hi Dr. Ada?"
// greet("Ada", null)             => static error: supplied title must be string
// greet("Ada", "Dr.", "?", 1)    => static error: arity is exact

choose: (value: string | null = "default") -> string | null => value
// choose()                       => "default": omission evaluates the lazy default
// choose(null)                   => null: explicit null is data and suppresses it

configure: ({ label = "", retries?, tags = [] }:
  { label?: string, retries?: integer, tags?: string[] }) -> string => label
// configure({ retries: 3 })      => object fields omit independently
```

Required parameters come first, followed by optional (`x?`) and defaulted
(`x = expr`) parameters, then at most one rest parameter (`...rest`), which
arrives as an array. Defaults are lazy and may reference any parameter in the
invocation; `?` and `=` cannot combine. Calls are positional, so a later
argument cannot be supplied while skipping an earlier slot—prefer one
object-pattern argument for independent options. Object patterns take one
plain object, have no renames or nesting, require their non-optional fields,
and ignore extra keys.

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
  if n == 0 then "empty"
  else `${str(n)} item(s), mean ${str(mean)}` where {
    mean: total / n, // never forced on the empty branch
    total: reduce((a, x) => a + x, 0, xs), // may refer to `n` above/below
    n: length(xs) // order does not matter
  }
```

The result comes first. Its locals form a lazy, memoized dependency graph,
not a statement sequence: order is irrelevant, mutual recursion works, and
cycles fail only if forced. Every binding must nevertheless be reachable from
the result or the checker reports it as unused. A function-valued local is a
named function and needs a full signature. Inner locals shadow parameters and
outer bindings.

```jfn
// `where` and `checked as` stop at commas and object-entry braces, so neither
// position needs defensive parentheses.
type StockLevel = { reserved: integer }
type Inventory = { [string]: StockLevel }
type Walk = { inv: Inventory, out: integer[] }

allocate: (inv: Inventory, line: integer) -> { inv: Inventory, alloc: integer } =>
  { inv, alloc: line }
walk: (inv: Inventory, lines: integer[]) -> Walk => reduce(
  (acc, line) => { inv: step.inv, out: concat(acc.out, [step.alloc]) }
    where { step: allocate(acc.inv, line) }, // comma ends this lambda body
  { inv, out: [] },
  lines
)
reserve: (sku: string, lvl: StockLevel, q: integer) -> Inventory =>
  { [sku]: merge(lvl, { reserved: lvl.reserved + q }) checked as StockLevel }

// A `where` otherwise covers the largest expression in its binding or arm.
ready: (input: integer) -> boolean => input > 0
repair: (input: integer) -> integer => input + 1
whole: (input: integer) -> integer =>
  if p then input else repair(input) where { p: ready(input) }
branch: (p: boolean, input: integer) -> integer =>
  if p then input
  else (fix(input) where { fix: (x: integer) -> integer => repair(x) })
```

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

type StockLevel = { onHand: integer }
type Inventory = { [string]: StockLevel }

// Statically, map and array reads have their element type, NOT `T | null`;
// no `!` or guard is needed merely to satisfy the checker. At runtime an
// absent key/index still returns null, so guard when absence is a real case.
onHand: (inv: Inventory, sku: string) -> integer =>
  if hasKey(inv, sku) then inv[sku].onHand else 0
```

- A **missing** object key or out-of-range index reads as `null`. But reading
  _through_ a present `null` errors (`a.b.c` when `a.b` is `null`), as does
  accessing a non-container. There is no `?.`. Use `!` to assert a value whose
  static type actually includes `null`, or to make an expected-presence check
  fail immediately at runtime.
- Keys are never coerced: arrays and strings require integer indices, objects
  require string keys. Index an object by a number's string form explicitly:
  `obj[str(n)]`.
- String indexing, `length`, and slicing count **Unicode code points**, not
  UTF-16 units (`"a😀b"[1]` is `"😀"`, length `3`).
- There is no assignment. Build updated data with expressions — typically
  `merge(obj, { field: newValue })`, `concat(xs, [x])`, spread literals
  (`{ ...obj, field: v }`), or `entries`/`fromEntries` pipelines. Adding a
  _new_ field this way yields a wider shape than the original closed object
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

Literal values are checked deeply against refinements at check time; only a
computed value whose inferred type has lost the refinement needs `checked as`:

```jfn
type Sku = string & pattern("^sku_")
type Percent = integer & min(0) & max(100)
type Offer = { sku: Sku, discount: Percent }

acceptOffer: (offer: Offer) -> Offer => offer
demoOffer: acceptOffer({ sku: "sku_widget", discount: 20 }) // statically valid
// badOffer: acceptOffer({ sku: "widget", discount: 120 })  // static errors
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

Narrowing is a small set — do not expect TypeScript
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
**inert data** — values called **tasks** that _describe_ an effectful step.
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
describeReading: (reading: Reading | null) -> string =>
  if isNull(reading) then "missing" else `read ${str(reading.temp)}C`

tick: (st: State) -> Task<State> => do {
  reading <- effects.sensor.read(), // run the task, bind its result
  // `reading: effects.sensor.read()` would bind the Task value instead;
  // passing that value to `describeReading` is a static type error.
  message: describeReading(reading), // ':' is a lazy pure local
  effects.log(message), // bare non-final entry: run, discard result
  pure(st) // final entry is the block's result
}
```

- **`name <- taskExpr` is the only entry that runs a task and binds its
  result.** `name: taskExpr` merely binds the task _value_ (lazily, with
  `where`-binding semantics). When the mistaken value is used as result data,
  full typing on the named function makes the `Task<T>`/`T` mismatch a static
  error with a source position.
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
greet: () -> Task<string> => do {
  rawName <- perform("io.readLine", []),
  name: rawName checked as string,
  perform("io.print", [`hello ${name}`]),
  pure(name)
}

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
  no `?.`. Map/array reads nevertheless have static type `T`, not `T | null`;
  guard when absence is real, and do not add `!` merely for the checker.
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
  Using an accidentally `:`-bound `Task<T>` as `T` is a static type error.
- No pattern matching beyond scalar `match` subjects and object-pattern
  parameters; no list comprehensions — use HOFs.

And json-fn specifics with no analogue elsewhere:

- Named functions (module and `where`-local) **must be fully typed**; inline
  HOF lambdas must stay bare.
- Refine inputs and boundaries freely; default computed fields to plain types.
  If a derived field deliberately stays refined, arithmetic writes must
  revalidate it with `checked as`, whose failures are hard errors rather than
  `raise`.
- Comparison chaining (`0 <= x < 100`) works and evaluates operands once.
- Two names are reserved: `Task` as a `type` name and `effects` as a
  top-level binding.
- Contract `$defs` and `effects` are injected into linked modules; do not
  re-declare names owned by the contract.
- `$`-prefixed keys are forbidden in object literals; wrap such data in
  `raw { … }` (strict JSON inside).

## 14. Builtin names

add, sub, mul, mod, div, neg, abs, floor, ceil, round, trunc, sign, clamp, max,
min, sum, mean, product, argmin, argmax, sqrt, pow, exp, log, log10, sin, cos,
tan, atan2, eq, neq, lt, lte, gt, gte, not, and, or, isNull, isBool, isNumber,
isInteger, isString, isArray, isObject, isTask, str, num, upper, lower, trim,
strcat, split, join, startsWith, endsWith, replace, padStart, padEnd, length,
head, last, tail, reverse, take, drop, zip, unique, repeat, flatten,
flattenDepth, chunk, frequencies, concat, range, rangeFrom, rangeBy, slice,
includes, indexOf, setAt, keys, values, entries, fromEntries, merge, hasKey,
pick, omit, map, mapIndexed, filter, filterIndexed, reduce, reduceIndexed,
partition, scan, find, findIndexed, findIndex, findIndexIndexed, some,
someIndexed, every, everyIndexed, count, countIndexed, countBy, sort, sortBy,
sortByIndexed, groupBy, groupByIndexed, flatMap, flatMapIndexed, mapValues,
apply, pipe, reTest, reMatch, reMatchAll, reReplace, reSplit, reReplaceWith,
perform, pure, bind, raise, handle, arity, tap
