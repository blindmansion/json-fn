# Variables, property access, calls, and references

## Variables and property access

A bare identifier is a variable (`{"$var":"x"}`). Any access on it lowers to a
`$get`/`$from` chain rooted at that `$var`; access on a non-variable expression
lowers to a `$get`/`$from` chain rooted at that expression.

A bare identifier resolves to a lexical binding, or to a function reference
when no lexical binding exists and the name is callable. Function-reference
fallback applies only to a plain name; property access always lowers through
`$var` and `$get`.

```jfn
x                         // {"$var":"x"}
a.b                       // {"$get":"b","$from":{"$var":"a"}}
a.b.c                     // {"$get":["b","c"],"$from":{"$var":"a"}}
a[0]                      // {"$get":0,"$from":{"$var":"a"}}
a[i]                      // {"$get":{"$var":"i"},"$from":{"$var":"a"}}
f(x).b                    // {"$get":"b","$from":{"$call":"f","$args":[{"$var":"x"}]}}
```

Lowering rules:

- Inside `[...]`, an **integer or quoted string** is a **static** key/index; a
  **bare identifier or any other expression** is a **computed** key.
- A run of consecutive **static** segments folds into one `$get` (a single
  string/number, or an array path for multiple): `a.b[0].c` →
  `{"$get":["b",0,"c"],"$from":{"$var":"a"}}`.
- A **computed** segment gets its own `$get`, wrapping the prior result as its
  `$from`: `a.b[i]` →
  `{"$get":{"$var":"i"},"$from":{"$get":"b","$from":{"$var":"a"}}}`.

Canonical JSON always uses `$get` with `$from`. `$var` contains only a bare
variable name.

An access chain **in call position** is a method call: the chain evaluates to a
function value that is then applied (`caps.db.query(sql)`). See
[Function calls and references](#function-calls-and-references).

## Function calls and references

In **call position**, a bare identifier is a literal function _name_; a
parenthesized expression is an _evaluated_ callee.

A name in call position, an operator that lowers to a named call, and a bare
function reference all use the same resolution. The lexical scope chain is
searched first. If it resolves to a function declaration
— a parameter, a `where`-local, or a module binding whose value is a function —
that binding shadows an outer callable with the same name. Otherwise resolution
continues through builtins and environment functions. A non-function lexical
binding shadows `$var` reads but not named-call resolution. A name absent from
both scopes is an error.

```jfn
add(3, 4)                 // named call
f()                       // zero-arg call
(fnName)(3, 4)            // dynamic dispatch (callee is an expression)
((x) => x * x)(5)         // inline function literal as callee
```

```json
{ "$call": "add", "$args": [3, 4] }
{ "$call": "f", "$args": [] }
{ "$call": { "$var": "fnName" }, "$args": [3, 4] }
{ "$call": { "$params": ["x"], "$return": { "$call": "mul", "$args": [{ "$var": "x" }, { "$var": "x" }] } }, "$args": [5] }
```

## Spread arguments

Arguments may be spread from an array. Ordinary argument runs become array
segments, those segments are combined with `concat`, and the callee plus final
argument array are passed to `apply`.

```jfn
f(first, ...middle, last)
```

```json
{
  "$call": "apply",
  "$args": [
    { "$fn": "f" },
    {
      "$call": "concat",
      "$args": [[{ "$var": "first" }], { "$var": "middle" }, [{ "$var": "last" }]]
    }
  ]
}
```

A sole spread lowers directly: `f(...args)` becomes `apply(&f, args)`.
Evaluated callees use their expression value instead of a `$fn` reference.
Every spread operand must evaluate to an array.

## Method calls and chained application

Any postfix expression that produces a function may appear in call position.
An access chain or preceding call is evaluated before its result is applied.
A bare name alone denotes a literal function name; adding `.`, `[…]`, or a
preceding call makes the callee an expression.

```jfn
caps.db.query(sql)        // call the closure held at caps.db.query
io.readLine()             // zero-arg method call
caps[name](x)             // computed-key dispatch
f(x).method(y)            // method on a call result (callee uses $get/$from)
makeCountdown(42)(3)      // chained application (call the returned closure)
```

```json
{ "$call": { "$get": ["db", "query"], "$from": { "$var": "caps" } }, "$args": [{ "$var": "sql" }] }
{ "$call": { "$get": "readLine", "$from": { "$var": "io" } }, "$args": [] }
{ "$call": { "$get": { "$var": "name" }, "$from": { "$var": "caps" } }, "$args": [{ "$var": "x" }] }
{ "$call": { "$get": "method", "$from": { "$call": "f", "$args": [{ "$var": "x" }] } }, "$args": [{ "$var": "y" }] }
{ "$call": { "$call": "makeCountdown", "$args": [42] }, "$args": [3] }
```

The resulting `$get`/`$from` or nested `$call` expression occupies the canonical
`$call` callee position.

## Function reference — `&`

Passes a function as a value (the language's `$fn` reference).

```jfn
&double                   // by name
map(&double, nums)
&(expr)                   // evaluated reference
```

```json
{ "$fn": "double" }
{ "$call": "map", "$args": [{ "$fn": "double" }, { "$var": "nums" }] }
{ "$fn": <expr> }
```

`&` is optional for a callable bare name:
`map(length, xs)` and `map(&length, xs)` are equivalent. The computed
`&(expr)` form has no bare equivalent. A lexical binding still takes
precedence in value position.

