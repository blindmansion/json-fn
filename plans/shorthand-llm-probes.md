# Where the shorthand over-promises: an LLM-inference probe log

## What this is

An experiment: an LLM was shown **only** two example programs (`examples/life.jfn`
and an older `chess.jfn`) and asked to infer the language, then deliberately write
code that *looks* like it should work based on those examples. We then ran the
guesses against the real interpreter to find every spot where the surface syntax
suggests a capability the language doesn't actually have (or hides one it does).

Reproduce with:

```bash
bun run typescript/examples/stretch.ts         # runtime / stdlib probes (one module)
bun run typescript/examples/stretch-syntax.ts  # syntax gambles (each isolated)
```

The probe sources live in `examples/stretch.jfn` and the two harnesses above.

---

## 1. Parse-fatal: the examples themselves use dead or inconsistent syntax

### 1a. `let { … } in expr` no longer exists

The `chess.jfn` example uses this form on nearly every line, so it was the natural
thing to reach for:

```jfn
f: (n) => let { a: n + 1 } in a * 2
```

```
parse error at 1:13: the 'let { ... } in expr' form is replaced by 'expr where { ... }'
```

`chess.jfn` is written in a dialect the current grammar rejects outright — it would
not parse today. `life.jfn` (which uses `where`) is the source of truth. Correct form:

```jfn
f: (n) => (a * 2) where { a: n + 1 }
```

### 1b. `match` requires an `else ->` arm

Both examples always had an `else`, but nothing signalled it was *mandatory*:

```jfn
f: (n) => match n { 1 -> "one", 2 -> "two" }
```

```
parse error at 1:48: match requires an 'else ->' arm
```

There is no such thing as a match that is total by enumeration; you must always
provide `else`.

### 1c. `where` cannot nest inside a `where`-binding value

Given that a function body is `expr where { … }`, it looked reasonable to attach a
`where` to a binding's value:

```jfn
f: (n) => r where {
  r: (a * 2) where { a: n + 1 }
}
```

```
parse error at 1:34: expected ',' or '}' in where-bindings
```

`where` only attaches to a *function body*, not to an arbitrary sub-expression. To
nest scopes you must introduce a lambda (this is exactly what `life.jfn`'s `parseNat`
does with its inner `loop`):

```jfn
f: (n) => compute(n) where {
  compute: (m) => (a * b) where { a: m + 1, b: m + 2 }
}
```

---

## 2. Runtime footguns: parses fine, behaves surprisingly

### 2a. Arithmetic operators are shadowable stdlib calls — the big one

The parser lowers every operator to a **named** stdlib call:

```146:161:typescript/src/shorthand/parser.ts
      if (type === "plus") {
        this.advance();
        left = fncall("add", [left, this.parseMul()]);
        leftIsConcat = false;
      } else if (type === "minus") {
        this.advance();
        left = fncall("sub", [left, this.parseMul()]);
        leftIsConcat = false;
      } else if (type === "plusplus") {
```

So `+`→`add`, `-`→`sub`, `*`→`mul`, `/`→`div`, `%`→`mod`, `++`→`strcat`, unary `-`→`neg`.
Because these are ordinary names, any top-level or local binding with the same name
**silently rebinds the operator**:

```jfn
{ add: (a, b) => a - b, f: (x) => x + 1 }
```

`f(10)` returns **`9`**, not `11` — `x + 1` desugars to `add(x, 1)`, which now subtracts.

This bit us immediately: our first draft used `add` as the curried-lambda demo
(`add: (a) => (b) => a + b`), which poisoned *every* `+` in the whole file. Renaming
it to `adder` fixed roughly six unrelated probes at once. Avoid naming anything
`add`/`sub`/`mul`/`div`/`mod`/`neg`/`strcat`.

### 2b. You cannot call a function-valued parameter with `f(x)`

The classic dense-lambda combinators look completely idiomatic:

```jfn
{
  twice:   (f) => (x) => f(f(x)),
  compose: (f, g) => (x) => f(g(x))
}
```

```
Function f not found
Function g not found
```

The reason is that a **bare identifier in call position is a literal function name**,
looked up in the registry — it is *not* a variable reference:

```203:208:typescript/src/shorthand/parser.ts
        // Bare identifier in call position is a literal function name; anything
        // else is an evaluated callee (spec section 4).
        const callee: JSONType = name !== null ? name : val;
        this.advance();
        const args = this.parseCallArgs();
        val = { $fn: [callee, ...args] };
```

`f` is a *parameter* (a value), so it isn't in the function registry → "not found".
The same name used as an *argument* (`map(f, xs)`) becomes a `$var` and resolves fine,
which is why higher-order functions are only "half" first-class: you can **pass** a
function value but not **directly invoke** one. Workarounds that do work:

```jfn
{ inc: (n) => n + 1, twiceInc: (x) => apply(inc, [apply(inc, [x])]) }   // twiceInc(0) => 2
```

…or chaining off a call/paren, which *is* an evaluated callee: `adder(10)(5)` ⇒ `15`,
and `((x) => x * x)(9)` ⇒ `81` both work.

### 2c. Object literals are not scopes

A value inside an object literal cannot reference a sibling key (that's what `where`
is for):

```jfn
f: (n) => { y: n + 1, z: y * 2 }
```

```
Invalid JSON expression: {
```

Plain object returns are fine (`{ y: n + 1, z: 5 }` ⇒ `{"y":4,"z":5}`); only the
cross-reference `z: y` fails. Use `where` if `z` needs `y`.

### 2d. `==` is reference/scalar equality, not structural

```788:789:typescript/src/evaluate.ts
    case "$eq":
      return left === right;
```

So `[1,2,3] == [1,2,3]` ⇒ `false`. The examples never compare compound values with
`==` (they walk arrays element-by-element), which hid this. Structural equality
exists but only as a separate builtin, `jsonEq(a, b)`.

### 2e. `cond` without `else` is non-total (and errors unhelpfully)

`cond` *does* parse without an `else`, but if no branch matches at runtime you get a
confusing `Invalid JSON expression: {` rather than a "no branch matched" message.
Always include `else ->` unless a branch is guaranteed to fire.

---

## 3. Missing stdlib the examples imply should exist

The two examples hand-roll filtering (via a `flatMap` trick) and folding (via manual
recursion), which made a lot of "obvious" helpers look absent. Some genuinely are:

| Tried | Result |
| --- | --- |
| `sum(xs)` | `Function sum not found` |
| `unique(xs)` | `Function unique not found` |
| `zip(a, b)` | `Function zip not found` |
| `take(xs, n)` / `drop(xs, n)` | `Function take/drop not found` |
| `count(pred, xs)` | `Function count not found` |
| `sqrt(x)` / `pow(a, b)` | `Function sqrt/pow not found` |
| `replace(s, a, b)` | `Function replace not found` (only regex `reReplace`) |
| `padStart(s, n, c)` | `Function padStart not found` |
| `repeat(s, n)` | `Function repeat not found` |
| `startsWith(s, p)` | `Function startsWith not found` |
| `sort(xs)` | `sort: second argument must be an array` — `sort` is `(comparator, arr)`, no default comparator |

---

## 4. Syntax gambles that simply aren't in the grammar

Each parses in isolation (`stretch-syntax.ts`), all fail:

| Feature | Tried | Error |
| --- | --- | --- |
| object spread | `{ ...s, gen: 0 }` | `expected data-object key, found 'dotdotdot'` |
| array spread | `[...xs, 99]` | `unexpected token 'dotdotdot'` |
| spread call args | `g(...xs)` | `unexpected token 'dotdotdot'` |
| computed key | `{ [k]: v }` | `expected data-object key, found 'lbracket'` |
| pipe operator | `xs \|> length` | `unexpected '\|'; use '\|\|'` |
| chained comparison | `0 <= x <= 7` | `comparison operators are non-associative` |
| default parameter | `(a, b = 1) =>` | `unexpected '='; use '==' or '=>'` |
| destructuring param | `([a, b]) =>` | `expected parameter name, found 'lbracket'` |
| block comment | `/* … */` | `unexpected token 'slash'` |

---

## 5. Under-promises: works better than the examples suggest

Worth documenting because the examples give no hint these exist:

- **The stdlib is much richer than shown**: `filter`, `reduce`, `every`, `find`,
  `sort`, `sortBy`, `flatten`, `max`, `min`, `keys`/`values`/`entries`, `merge`,
  `pipe`, `groupBy`, `apply`, and a full regex family are all present.
- **Every higher-order builtin passes an index** as the callback's 2nd argument:
  `map((x, i) => [i, x], xs)` ⇒ `[[0,"a"],[1,"b"]]`.
- **`match` cases are evaluated expressions, not just literals**: `match x { y -> … }`
  compares against the *variable* `y` — the examples only ever show string literals.
- **Chained application and namespaces work**: `adder(10)(5)` ⇒ `15`, IIFEs work, and a
  nested object of functions can be called method-style (`ns.inc(n)`).
- **JS-ish value semantics**: `s[i]` indexes strings, missing keys return `null`,
  `if`/`!` use truthiness (`if 0` is false), `/` is float division, `%` and unary `-`
  follow JS, and negative `slice` indices work (`slice("hello", -2)` ⇒ `"lo"`).
- **`// line comments` and multi-line backtick strings** are supported.
- **`...rest` parameters work** (`(...xs) => length(xs)`), even though no example uses them.
