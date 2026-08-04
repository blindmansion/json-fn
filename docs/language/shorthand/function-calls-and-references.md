# 4. Function calls and references

In **call position**, a bare identifier is a literal function _name_; a
parenthesized expression is an _evaluated_ callee.

**Name resolution is lexical-first, registry-second — uniformly.** A name in
call position (a direct call `f(x)`, an operator that desugars to a named call
like `+`→`add`, or a bare reference used as a value) resolves against the
enclosing lexical scope chain first. If it resolves to a _function declaration_
— a parameter, a `where`-local, or a module binding whose value is a function —
that binding is used, **shadowing** any same-named stdlib/host builtin. If the
lexical binding is _not_ a function (e.g. `add: 5`), or there is no lexical
binding, resolution falls through to the function registry (scoped local
functions + stdlib/host). Only if both miss is it an error. This makes operator
desugaring, direct calls, and bare references agree on shadowing.

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

A sole spread avoids the unnecessary `concat`: `f(...args)` lowers to
`apply(&f, args)`. The `$fn` wrapper preserves the lexical-first,
registry-second behavior of an ordinary named call. Evaluated callees use their
ordinary expression value instead. Spread operands must evaluate to arrays.
The current `core.apply` checker rule is intentionally imprecise, so a spread
call's result type degrades to `any` even when the callee has a known signature;
this is a checker limitation, not a new canonical JSON form. Because `any`
does not prove assignability to a concrete return type, use a checked
ascription (`f(...args) checked as T`) when the runtime boundary is intentional. Use
`--require-full-coverage` when the remaining spread-call imprecision must also
be rejected.

## Method calls and chained application

The callee slot is a full postfix expression, so anything that produces a
function value can sit in call position. In particular, a **property-access
chain** or a **preceding call** in call position is an evaluated callee — the
access/call is performed first and its result is applied. This is the
"method-call" surface: it dispatches through a record of closures (the pattern
capabilities use — see `plans/effects-implementation.md`), with no distinct
`$` form. A bare name is still the only thing that means a literal function
_name_ (`f(x)` → `{ "$call": "f", "$args": [ … ] }`); the moment a `.`, `[…]`, or a prior
`(…)` intervenes, the callee is evaluated.

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

The callee lowering is exactly the [property-access lowering](variables-and-property-access.md) (a `$get`/`$from`
chain rooted at a variable or an arbitrary expression), placed in the `$call`
position of the call node.

> **Printer note (deferred).** These forms parse and evaluate today, but the
> canonical pretty-printer currently wraps the callee in parentheses
> (`(caps.db.query)(sql)`, `(makeCountdown(42))(3)`). That still round-trips —
> `parse(print(x))` is `x` — so the bijective-by-normal-form guarantee holds; it
> is only less pretty than the bare source. Tightening the printer to emit the
> bare form for access-headed and call-headed callees (while keeping the parens
> on a bare `$var` callee, since `f(x)` would otherwise collide with a
> literal-name call) is tracked as an [open decision](open-decisions.md).

## Function reference — `&`

Passes a function as a value (the language's `$fn` reference).

```jfn
&double                   // by name
map(&double, nums)
&(expr)                   // evaluated reference (rare)
```

```json
{ "$fn": "double" }
{ "$call": "map", "$args": [{ "$fn": "double" }, { "$var": "nums" }] }
{ "$fn": <expr> }
```

**`&` is optional for a bare name.** Because a bare identifier in value position
falls through to the [registry](variables-and-property-access.md), a registered function name resolves to its
reference without `&`: `map(length, xs)` == `map(&length, xs)`. Use `&` when you
want to be explicit, and reserve it for the computed `&(expr)` form, which has no
bare equivalent. A lexical binding still wins over the registry, so a local named
`length` shadows the builtin in value position too.

---

