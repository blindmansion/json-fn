# json-fn Language Reference

json-fn is a JSON-structured expression language. Programs are JSON values evaluated by a tree-walking interpreter. All expressions are valid JSON.

## Expression Types

Every JSON value is an expression. The interpreter determines its type by shape:

### Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

### Arrays

Each element is evaluated recursively. `[1, { "$call": "add", "$args": [2, 3] }]` evaluates to `[1, 5]`.

### Plain Objects

Each value is evaluated recursively (keys are not). `{ "x": { "$call": "add", "$args": [1, 2] } }` evaluates to `{ "x": 3 }`.

### Function Call — `{ $call, $args }`

Calls a function. `$call` is the callee (a name, body, or expression that resolves to one) and `$args` is the array of arguments. Both keys are required; `$args` may be empty.

```json
{ "$call": "add", "$args": [3, 4] }
```

Nested calls — arguments can themselves be calls:

```json
{
  "$call": "mul",
  "$args": [{ "$call": "add", "$args": [2, 3] }, { "$call": "sub", "$args": [10, 4] }]
}
```

Zero-argument calls use an empty `$args` array:

```json
{ "$call": "myFunction", "$args": [] }
```

### Function Reference — `{ $fn }`

`$fn` evaluates its value and returns the result (a string name or function body) without calling it. Used to pass functions as values to higher-order functions. `$fn` is never an array — an array `$fn` is a pre-split artifact and is rejected.

```json
{ "$fn": "double" }
```

### Variable Reference — `{ $var }`

Resolves a variable by name. `$var` must be the sole key, and its value is a plain variable name looked up directly in scope — there is no dot/bracket path notation and no `$get` sibling.

```json
{ "$var": "x" }
```

### Non-null assertion — `{ $cast }`

Evaluates `$cast` and returns its value when non-null. If the value is `null`,
evaluation fails. `$cast` must be the sole key.

```json
{ "$cast": { "$var": "x" } }
```

The checker removes `null` from the operand's inferred type. In shorthand this
is written as the postfix operator `x!`.

Refinements are intentionally opaque to arithmetic. For example, if
`Score = integer & min(0)`, arithmetic involving a `Score` produces `integer`;
the checker does not infer that the result still satisfies `min(0)`. Postfix
`!` only removes `null` and does not establish a refinement. Keep such
calculations at the primitive type and, when a refined result must be asserted,
validate it at an explicit runtime contract boundary such as a total annotated
`handle` result. Static arithmetic/refinement inference is not supported.

### Property Access — `{ $get, $from }`

All property access uses `$get`/`$from`. `$from` evaluates to the target and `$get` evaluates to the key read from it:

```json
{ "$get": "name", "$from": { "$var": "person" } }
{ "$get": 1, "$from": { "$var": "items" } }
{ "$get": ["address", "city"], "$from": { "$var": "person" } }
{ "$get": { "$var": "fieldName" }, "$from": { "$var": "data" } }
{ "$get": 0, "$from": { "$call": "concat", "$args": [[10], [20]] } }
```

`$get` evaluates to one of:

- a **string** key — reads an object property (`null` if the key is missing);
- a **number** index — reads an array element, or a character from a string (`null` if out of bounds);
- an **array** — a static path walked segment by segment, applying the per-segment rules above at each step.

`$from` may be any expression: a variable, a function result, a literal, or another `$get`/`$from` chain (nest them to walk deeper). Path traversal into a `null` or missing intermediate value returns `null`; a non-numeric `$get` on a string errors, as does a `$get` whose target is not an object, array, or string. `$get`/`$from` must be the only two keys.

### Function Body — `{ $return, ... }`

Defines a function. Required key: `$return` (the expression to evaluate when called). Optional key: `$params` (an ordered array of parameter **slots** — see [Parameters](#parameters--params)). All other keys are **lazy local variables** — evaluated on first access.

```json
{
  "$params": ["n"],
  "remainder": { "$call": "mod", "$args": [{ "$var": "n" }, 2] },
  "$return": { "$call": "eq", "$args": [{ "$var": "remainder" }, 0] }
}
```

When a function body appears in expression position (not as the top-level target of a call), it is treated as a closure — outer variables are substituted into it.

### Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

### Multi-branch Conditional — `{ $cond }`

Array of `[condition, result]` pairs. First truthy condition wins. If no condition matches, optional `$else` is evaluated and returned; without `$else`, the interpreter errors. Only the matched result or `$else` is evaluated.

```json
{
  "$cond": [
    [{ "$call": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$call": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"]
  ],
  "$else": "positive"
}
```

`[true, ...]` still works as an explicit catch-all branch when you prefer to keep all branches inside the `$cond` array.

### Scalar Value Match — `{ $match, $cases, $else }`

Evaluates `$match`, then checks `$cases` left-to-right. Each case is a `[value, result]` pair; the first case value that is strictly equal to the matched value wins. `$match` and case values must evaluate to scalar JSON values (`null`, boolean, number, or string); arrays and objects are rejected instead of compared structurally. `$else` is required and is evaluated only if no case matches.

```json
{
  "$match": { "$var": "cmd" },
  "$cases": [
    ["show", { "$call": "showResult", "$args": [{ "$var": "state" }] }],
    ["reset", { "$call": "resetResult", "$args": [] }],
    ["help", { "$call": "helpResult", "$args": [] }]
  ],
  "$else": { "$call": "moveResult", "$args": [{ "$var": "state" }, { "$var": "argv" }] }
}
```

### Short-Circuit And — `{ $and }`

Array of expressions evaluated left-to-right. Returns the first falsy value, or the last value if all are truthy. Short-circuits (stops evaluating after the first falsy result).

```json
{
  "$and": [{ "$call": "gt", "$args": [{ "$var": "x" }, 0] }, { "$call": "lt", "$args": [{ "$var": "x" }, 100] }, "in range"]
}
```

Unlike the stdlib `and` function, `$and` does **not** evaluate all its operands — it is a language-level special form. It is also variadic (any number of operands).

### Short-Circuit Or — `{ $or }`

Array of expressions evaluated left-to-right. Returns the first truthy value, or the last value if all are falsy. Short-circuits (stops evaluating after the first truthy result).

```json
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
```

Comparison and negation have **no dedicated expression forms**. Comparisons (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`) and logical negation (`not`) are ordinary [standard-library functions](#comparison) called via `$call`/`$args`:

```json
{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }
{ "$call": "gte", "$args": [{ "$var": "score" }, 10] }
{ "$call": "not", "$args": [{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }] }
```

`eq` and `neq` are **structural** (deep) equality — the only equality json-fn has (see [Standard Library → Comparison](#comparison)).

### Raw — `{ $raw }`

Returns the value as-is without evaluating nested expressions. Use for constant data in hot paths or to prevent keyword collisions (data that happens to contain `$fn`, `$var`, etc. keys).

```json
{
  "$raw": [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8]
  ]
}
```

### Comments — `$comment`

A `$comment` key with a string value is ignored everywhere it appears as a sibling key in any expression form, and is stripped from plain-data objects. It survives JSON serialization, so unlike JSONC comments it round-trips through `parse → transform → stringify`.

```json
{
  "$comment": "classify a number by sign",
  "$params": ["n"],
  "$return": {
    "$cond": [
      [{ "$call": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
      [{ "$call": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"],
      [true, "positive"]
    ]
  }
}
```

Rules:

- The value **must be a string** to be recognized as a comment. Non-string values are treated as normal keys (and will typically cause "expression cannot have other properties" errors in expression forms).
- Allowed as a sibling key in any expression form (`$call`/`$args`, `$fn`, `$var`, `$if`/`$then`/`$else`, `$cond`, `$and`, `$or`, `$raw`, `$get`/`$from`, `$return`/`$params`/locals).
- In plain data objects, `$comment` is stripped from the output. To preserve a literal `$comment` key in data, wrap with `$raw`.
- Inside `$raw`, the entire value is returned verbatim — `$comment` is preserved.
- Closures preserve `$comment` when a function body is returned as a value.

## Function Bodies

A function body has `$return` and optionally `$params`. All other keys are lazy locals.

### Parameters — `$params`

An ordered array of parameter **slots**. Each slot is a name string (a required
positional parameter), a `{ "$param": name, "$default": expression }`
descriptor (a defaulted positional parameter), a `"...rest"` collector (see
[Rest Parameters](#rest-parameters)), or an object pattern (see
[Object-Pattern Parameters](#object-pattern-parameters--fields)). Fixed
arguments are bound positionally, one per slot.

```json
{
  "$params": ["a", { "$param": "b", "$default": 1 }],
  "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
}
```

A name string is required: omitting its argument is an error. A defaulted
parameter may be omitted, in which case its `$default` expression is evaluated
lazily when the binding is first read. Calls cannot skip a positional slot:
passing `null` explicitly supplies `null` and suppresses the default.

Required positional slots—including object patterns—must precede all defaulted
positional slots. Any number of defaulted slots may form the omittable suffix,
followed only by an optional final rest parameter. For example,
`["required", { "$param": "fallback", "$default": 0 }, "...rest"]` is valid,
while `[{ "$param": "fallback", "$default": 0 }, "required"]` is not.

A function without a rest parameter rejects any argument beyond its exact
number of fixed slots; extra fixed arguments are not ignored. A rest parameter
allows additional arguments as described below.

### Rest Parameters

A final parameter starting with `...` collects all arguments remaining after
the fixed slots into an array. It receives an empty array when there are no
remaining arguments.

```json
{
  "$params": ["first", "...rest"],
  "$return": { "$var": "rest" }
}
```

Called with args `[1, 2, 3]`: `first` = `1`, `rest` = `[2, 3]`.

### Object-Pattern Parameters — `$fields`

A `$params` slot may be an **object pattern** instead of a name string: an object
of the exact shape `{ "$fields": [...] }`. Its non-empty array contains required
field-name strings and/or defaulted field descriptors of the form
`{ "$field": name, "$default": expression }`. The pattern destructures one
positional object argument, binding each field to a local of the same name.

```json
{
  "$params": [{ "$fields": ["from", "to"] }],
  "$return": { "$call": "sub", "$args": [{ "$var": "to" }, { "$var": "from" }] }
}
```

Called with args `[{ "from": 3, "to": 7 }]`: `from` = `3`, `to` = `7`, result `4`. The **calling convention is unchanged** — this is an ordinary positional call passing one plain-data object; the "named-ness" lives entirely in the parameter.

Binding rules for a pattern slot at position `i`, where `v` is the supplied
`i`-th argument:

- The whole pattern argument is required, even if every field has a default.
- `v` must be a plain object (not an array and not `null`). Any other value,
  including explicit `null`, is an error.
- A required field-name string must be an own property of `v`; an absent or
  inherited field is an error.
- A defaulted field uses its `$default` only when the own property is absent.
  The default is evaluated lazily when the binding is first read.
- An own property whose value is `null` is supplied data: it binds `null` and
  suppresses a field default.
- Extra object keys are ignored.

Supplied field bindings are established at call time; defaulted bindings remain
lazy. Within the body they are visible via `$var` to `$return` and to lazy
locals, and they **shadow** same-named outer bindings at any nesting depth.

Additional rules:

- `$fields` must be a **non-empty** array of field-name strings and/or
  `{ "$field": name, "$default": expression }` descriptors. Field names must
  not contain `.` or `[`.
- A `$fields` object is valid only as a `$params` slot; it may not be preceded by `...`.
- A pattern slot consumes exactly **one required** positional argument, so it
  may appear with other required slots before defaulted slots, and before an
  optional final rest parameter (`["label", { "$fields": ["x", "y"] }]`,
  `[{ "$fields": ["x"] }, "...rest"]`).
- Defaults within `$fields` affect property omission only. Even a pattern whose
  fields are all defaulted remains a required positional slot and cannot follow
  a defaulted positional parameter.
- `arity` counts a pattern slot as one parameter.

Rename and nested patterns are not supported.

### Lazy Local Variables

Any key other than `$return` and `$params` defines a local variable. Locals are evaluated lazily (on first `$var` access) and can reference each other and `$params`. Key order within a function body does not affect evaluation — locals form a dependency graph resolved on demand, so the body behaves identically regardless of how a JSON parser orders the keys.

```json
{
  "$params": ["x", "y"],
  "sum": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$call": "mul", "$args": [{ "$var": "sum" }, 2] },
  "$return": { "$var": "doubled" }
}
```

## Closures

When a function body is returned as a value (not called), outer variables are captured by substitution. The interpreter walks the returned body and replaces `$var` references with their current values, respecting scope boundaries — inner `$params` and locals shadow outer names.

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$call": "add", "$args": [10, { "$var": "y" }] }
}
```

The returned body is a valid function body that can be called subsequently.

### Escaping closures carry the local functions they call

Capture also keeps an escaping closure **self-contained** when it calls an enclosing [local function](#local-recursive-functions) by name. Names in call position that resolve to a local function stay literal (so recursion and mutual recursion keep dispatching by name), and capture re-attaches those functions' closed-over definitions as locals on the returned body. A closure that recurses — or that calls a sibling local — therefore remains callable after it leaves the scope that defined those functions.

```json
{
  "$params": ["base"],
  "go": {
    "$params": ["x"],
    "$return": {
      "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
      "$then": { "$var": "base" },
      "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
    }
  },
  "$return": { "$var": "go" }
}
```

Called with `[42]`, returns a body that carries `go` as an attached local so it still recurses when invoked later:

```json
{
  "$params": ["x"],
  "go": {
    "$params": ["x"],
    "$return": {
      "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
      "$then": 42,
      "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
    }
  },
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
    "$then": 42,
    "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
  }
}
```

Only the local functions actually referenced (transitively) are attached, and a name shadowed by the returned body's own `$params` or locals is never attached — the inner binder wins.

**Module-level (registry) functions are not attached.** Attachment applies only to functions defined by an *enclosing scope that goes away* when the closure escapes it — `where`-locals and nested locals. A top-level module function lives in the registry for the whole program, so an in-program reference to it never dangles and it resolves by name at call time like a stdlib builtin; attaching it would be redundant and, for a self-referential constructor that returns a record of closures (`makeThing` → `{ … next: () => makeThing(…) }`), would make capture copy the definition into itself on every call and blow up super-exponentially. The consequence is a small, consistent contract: a closure serialized and shipped *out of the program* keeps its local functions inline, but still relies on the target host providing the registry (module + stdlib) — exactly as it already relies on `add`, `map`, and friends being present.

## Scoping Rules

- `$params` and local variable keys create a scope within their function body.
- Inner scopes shadow outer scopes: if an inner function body has a `$param` or local named `x`, outer `x` is not substituted into it.
- Variables resolve by walking up the scope chain: params first, then locals in the current body, then the parent scope.

## Recursion

Functions can call themselves by name if registered in the function registry.

```json
{
  "$params": ["n"],
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "n" }, 1] },
    "$then": 1,
    "$else": {
      "$call": "mul",
      "$args": [{ "$var": "n" }, { "$call": "fact", "$args": [{ "$call": "sub", "$args": [{ "$var": "n" }, 1] }] }]
    }
  }
}
```

### Local Recursive Functions

Local variables whose values are function bodies (have a `$return` key) can be called by name within their scope. This enables recursion without registering in the global registry. Mutual recursion between sibling locals works too.

```json
{
  "$params": ["n"],
  "fact": {
    "$params": ["x"],
    "$return": {
      "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 1] },
      "$then": 1,
      "$else": {
        "$call": "mul",
        "$args": [{ "$var": "x" }, { "$call": "fact", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }]
      }
    }
  },
  "$return": { "$call": "fact", "$args": [{ "$var": "n" }] }
}
```

Local function names can shadow global registry functions and do not leak into parent or sibling scopes.

## Module Scope

A whole program is an **object mapping names to expressions** — the same shape as a function body's locals. When a host runs such an object as a program (choosing an entry point to invoke), that object is itself a **recursive, lazy binding scope**, identical in semantics to the locals inside a function body:

- Top-level **constants** (`SIZE`, `OFFSETS`, …) are visible via `$var` throughout the module.
- Top-level **functions** are callable via `$call` and, being bindings, are also `$var`-visible as function values (so they can be passed by name to higher-order functions).
- Bindings are lazy (evaluated on first reference, then memoized), order-independent, mutually recursive, and cycle-checked — exactly like locals.

```json
{
  "W": 20,
  "H": 12,
  "SIZE": { "$call": "mul", "$args": [{ "$var": "W" }, { "$var": "H" }] },
  "area": { "$return": { "$var": "SIZE" } }
}
```

Running this program with entry `area` returns `240`: the top-level constant `SIZE` (itself defined in terms of `W` and `H`) is read as a plain `$var`, no nullary-function workaround required.

### The boundary rule

The module scope composes with the host-supplied registry (stdlib + native builtins) by **one rule**:

> The module object is the **outermost lexical frame**; the host/stdlib registry is its **parent frame**. Callee (`$call`) and `$var` resolution are unchanged except that they now walk one additional frame.

Consequences:

- **Shadowing.** A module binding shadows a same-named registry entry (stdlib is the parent frame).
- **Inner binders still win.** A function's `$params` or locals shadow a module constant of the same name, at any nesting depth — module scope is just the outermost link in the same chain described under [Scoping Rules](#scoping-rules).
- **Lisp-2 asymmetry (by syntax, not runtime type).** Only a binding whose value is _literally_ a function body (has a `$return` key) becomes callable in `$call` position. So a module _constant_ named `map` shadows `$var map` but **not** a `$call` to `map` (which still resolves the stdlib `map`), even if that constant happens to evaluate to a function; a module _function_ named `map` shadows **both**.

This is a single outermost frame, not a module _system_: there is no `import` / `export`, no multiple modules, and no re-exports.

## Dynamic Dispatch

The callee `$call` can be a `$var` reference or any expression that evaluates to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$call": { "$var": "fnName" }, "$args": [3, 4] }
}
```

Called with `["add"]` returns `7`. Called with `["mul"]` returns `12`.

## Tasks & Effects

json-fn is pure: evaluating an expression never performs I/O or any observable side effect. **Effects** are represented as *data* — inert values called **tasks** that *describe* an effectful computation without running it. Running a task is a separate step, performed either in-language by the `handle` builtin (which interprets each effect) or at the host boundary by a trampoline (`runTask`) that answers effects with real I/O.

The kernel is deliberately small: three task **constructors** (`perform`, `pure`, `bind`), one `raise` convenience, and one `handle` builtin. Everything richer — retries, error recovery, threaded state, dry-runs, capability attenuation — is ordinary json-fn library code, because [escaping-closure capture](#escaping-closures-carry-the-local-functions-they-call) makes every suspended continuation a self-contained JSON value.

### Task representation

A task is a tagged plain object. The tag key is `@task` — deliberately **not** a `$`-key, so a task classifies as an ordinary object and is never re-interpreted as an expression form. Tasks are **inert**: once built they are returned, stored, and passed around verbatim, never re-evaluated. There are three node kinds:

```json
{ "@task": "effect", "name": "http.get", "args": ["https://example.com"] }
{ "@task": "pure", "value": 42 }
{ "@task": "bind", "task": { "@task": "pure", "value": 1 }, "then": { "$params": ["x"], "$return": { "$call": "pure", "$args": [{ "$var": "x" }] } } }
```

- **`effect`** requests one effect by `name`, carrying its `args`. `raise(err)` is the distinguished effect named `raise`.
- **`pure`** is a completed task whose result is `value`.
- **`bind`** sequences: run `task`, then apply the continuation `then` (an ordinary one-parameter function) to its result to obtain the next task.

Because tasks are inert data, laziness composes with them cleanly: a task held in an [unreferenced lazy local](#lazy-local-variables) is never built, and building a task never performs its effect. Nothing happens until something *runs* the task.

### Constructors

These are standard-library functions (see [Standard Library → Tasks & Effects](#tasks--effects-1)):

- `perform(name, args)` — build an `effect` task. `name` must be a string, `args` an array.
- `pure(value)` — build a completed task carrying `value`.
- `bind(task, k)` — sequence; `k` must be a function (registry name or body).
- `raise(err)` — convenience for `perform("raise", [err])`.

When the checker is configured with an effect manifest, each literal effect
name has positional argument schemas and a result schema. `perform` checks those
arguments, and the result type flows through `bind` (and therefore `do`
notation). Guest signatures may preserve that index explicitly with `Task<A>`;
bare `Task` means `Task<any>`. `Task` is the one built-in type constructor and
cannot be redefined; general user-facing generics remain unsupported. The index
is checker-only, and task records contain no runtime type metadata. A dynamic
effect name cannot be resolved statically and is reported as degraded type
coverage.

An environment-configured module also receives a reserved `effects` binding
derived from that manifest. Dot-separated effect names become nested callable
paths:

```jfn
effects.http.get(url)
effects.log("starting")
```

Each leaf is a typed task constructor equivalent to a literal
`perform("http.get", [url])`; calling it remains pure and does not invoke the
host capability. Qualification distinguishes effects from direct functions, so
`log(...)` and `effects.log(...)` may coexist with different semantics. A module
checked or run with an environment may not declare its own top-level `effects`
binding. Manifest names may not be namespace prefixes of other names (for
example, `sensor` and `sensor.read` cannot both be declared). Raw `perform`
remains available as a low-level constructor.

Malformed tasks (e.g. a `bind` whose `then` is not a function, or an `effect` with a non-string `name`) are rejected as ordinary **guest-visible evaluation errors** when the task is run — never as host-language exceptions.

### The suspended form

Running a task normalizes it — walking the `bind` spine — to exactly one of two shapes. This pair is the stable contract shared by `handle`, the host trampoline, and durable storage:

```json
{ "done": 42 }
{ "pending": { "name": "http.get", "args": ["https://example.com"], "resume": { "$params": ["__v"], "$return": "..." } } }
```

`resume` is an ordinary self-contained closure `(value) => <task>`: apply it to the effect's result to continue. Because escaping-closure capture keeps it self-contained, a `pending` record is plain JSON — persist it, ship it across a process boundary, print it as shorthand, or apply it **more than once** (multi-shot).

### `handle` — interpreting effects in-language

`handle(task, clauses)` runs a task, dispatching each effect it performs to a matching clause in the `clauses` record. This is a pure, in-language interpreter for effects — no host involved — which is what makes effectful code testable. This two-argument form is **partial**: unmatched effects bubble.

`handle(task, clauses, raw(resultSchema))` is the **total annotated** form, written in shorthand as `handle task -> ResultType with { … }`. Its immediate result is checked against `resultSchema` at runtime, and the checker gives the expression that declared type. An unmatched effect is a `RuntimeContractError` instead of a residual task. The annotation is retained by every generated `resume`, and named types resolve through the active module's `$types`.

Clause lookup is by effect name:

- A **named clause** `"http.get": (url, resume) => …` receives the effect's args spread positionally, then `resume` last.
- The reserved **`"*"` wildcard** clause `"*": (eff, resume) => …` catches any otherwise-unmatched effect and receives `eff = { name, args }` plus `resume`.
- The reserved **`"return"` clause** `"return": (v) => …` runs when the task completes normally with value `v`; its result is final and is **not** re-interpreted by this handler. Without a `"return"` clause, `handle` returns the completion value directly.

For an annotated total handler of `Task<A>` with result annotation `R`, the
checker contextually types each manifest-backed clause as
`(...effectArgs, resume: (effectResult) -> R) -> R` and types `return` as
`(A) -> R`. Wildcard and built-in `raise` payloads remain broad because
`Task<A>` does not track an effect row or raised-payload type. The unannotated
partial form has no declared `R`, so it retains its imprecise static result.

`resume` is itself plain JSON built by `handle`, so continuations stay serializable mid-handle and multi-shot resumption is free: calling `resume` twice re-runs the rest of the task twice (the basis for nondeterminism, retry, and backtracking combinators).

**Bubbling.** In the partial form, an effect with no matching clause (and no `"*"`) is *not* an error: `handle` re-performs it, wrapping the surrounding continuation so it re-enters the same handler afterward. The effect bubbles outward to the next enclosing `handle`, and ultimately to the host. This is what lets a partial handler discharge only the effects it cares about while staying transparent to the rest of the effect set. The annotated form is total and rejects the same unmatched effect.

For a function result annotation such as `(State) -> Report`, validation installs a serializable callable boundary. The function value is checked when produced; each eventual argument and return value is checked when it is called. This is what lets a state handler declare its actual immediate result:

```jfn
(handle task -> (ScriptState) -> Report with {
  // clauses return functions awaiting ScriptState
})(initialState)
```

```jfn
handle greet(mockIo()) with {
  "io.readLine": (resume) => resume("world"),
  "io.print":    (msg, resume) => resume(null)
}
```

Handler clauses are invoked through the normal call path, so fuel and call-depth metering apply; task normalization additionally charges fuel per interpreted node.

### Host trampoline

`handle` interprets effects *in-language*; to connect a task to the real world,
a host drives it with `runTask` (in TypeScript, exported from the package).
The preferred typed form takes one operator-owned environment:

```ts
const environment = {
  $defs: { /* shared domain schemas */ },
  functions: { /* direct host callable contracts */ },
  effects: { /* capability argument/result contracts */ },
  entry: {
    name: "main",
    required: [],
    optional: [],
    returns: { task: { type: "string" } },
  },
};

const result = await runTask(module, environment, [], {
  registry,
  capabilities: {
    "io.readLine": async () => prompt(),
    "io.print": async (msg) => { console.log(msg); },
  },
}, limits);
```

The host is the *outermost handler*: any effect that no in-language `handle` discharged bubbles all the way out to `runTask`, which

- returns the value on `{ done }`;
- throws `TaskRaiseError` (carrying the guest payload) for an unhandled `raise`;
- throws `UnhandledEffectError` for an effect with no capability;
- otherwise `await`s the capability, applies `resume` to its result, and loops.

The environment is portable contract data, separate from the host
implementations. Its `functions` use the same fallback signatures and optional
rules as core builtins. Callable-name collisions are rejected rather than
overridden. Entry contracts use mandatory `required` and `optional` arrays in
that order; optional entry arguments are represented structurally but are not
yet omission-aware. `entry.returns: { task: A }` describes the task's eventual
completion value.

`runTask` validates entry arguments and completion, wraps tractable direct host
functions to validate their arguments/results, rejects effects absent from the
environment, validates outgoing effect arguments before invoking host code, and
validates capability results before resuming. Named references use the same
merged builtin/environment/module definition pool as the checker.

`jfn check --environment <path>` loads the same artifact, preloads its named
types, functions, and effects, and checks the entry body contextually against
the environment-owned signature. `jfn eval --environment <path>` executes that
entry through the same validated host API. Adding `--function <name>` selects a
development evaluation instead: the CLI injects the environment's definitions
and generated `effects` namespace, then invokes that named module function
without claiming it satisfies the production entry contract. This is suitable
for in-language demos whose handlers discharge their own effects; it does not
synthesize implementations for direct host functions or effects that escape to
the host.

**Durable suspend/resume.** Because a `pending` task is plain JSON, a host can `serializeTask` it, store it, and later `hydrateTask` + resume — even in a different process. `hydrateTask` restores the inertness marks that keep embedded tasks opaque to the evaluator.

**Static admission.** `requiredCapabilities(module | task, environment?)` walks
the JSON and returns the effect names a program could ever perform, as
`{ names, dynamic }`. Supplying the environment also recognizes calls through
the generated `effects` namespace. A host can enumerate what a program might ask
for _before_ running it and reject at admission time rather than hitting
`UnhandledEffectError` mid-run. It is a conservative over-approximation — it
does **not** subtract effects an in-language `handle` discharges — and sets
`dynamic: true` when a `perform` name or `effects` access is computed.

**Idempotency caveat.** `runTask` answers each `pending` exactly once, but durable suspend/resume makes **at-least-once** effect execution the practical reality: a crash between running a capability and persisting the resumed task reruns that effect on recovery (the same tradeoff as Temporal). In-language multi-shot `resume` is a feature; at the host boundary, replay is not free — capabilities with external side effects should take idempotency keys.

## Standard Library

All functions listed below are available in the standard library.

### Arithmetic

| Function | Args     | Description              |
| -------- | -------- | ------------------------ |
| `add`    | `(a, b)` | `a + b`                  |
| `sub`    | `(a, b)` | `a - b`                  |
| `mul`    | `(a, b)` | `a * b`                  |
| `div`    | `(a, b)` | `a / b` (throws on zero) |
| `mod`    | `(a, b)` | `a % b` (throws on zero) |
| `abs`    | `(a)`    | absolute value           |
| `neg`    | `(a)`    | `-a`                     |
| `floor`  | `(a)`    | floor                    |
| `ceil`   | `(a)`    | ceiling                  |
| `round`  | `(a)`    | round                    |
| `max`    | `(arr)`  | maximum number; throws for an empty array or non-finite result |
| `min`    | `(arr)`  | minimum number; throws for an empty array or non-finite result |
| `sum`    | `(arr)`  | sum of numbers (`0` if empty); throws if the result is not finite |
| `sqrt`   | `(a)`    | square root; throws if the result is not finite |
| `pow`    | `(base, exponent)` | exponentiation; throws if the result is not finite |

Arithmetic builtins reject results that are `NaN` or infinite, since those are
not JSON numbers.

### Comparison

| Function | Args     | Description             |
| -------- | -------- | ----------------------- |
| `eq`     | `(a, b)` | structural equality     |
| `neq`    | `(a, b)` | structural inequality   |
| `gt`     | `(a, b)` | `a > b`                 |
| `gte`    | `(a, b)` | `a >= b`                |
| `lt`     | `(a, b)` | `a < b`                 |
| `lte`    | `(a, b)` | `a <= b`                |

`eq`/`neq` are **structural**: arrays and objects are compared recursively and object key order does not matter (on scalars this is just `===`). This is the only equality — json-fn values are immutable JSON, so there is no observable reference identity to compare. Equality does **not** coerce types, so `true` is not `1` and `"1"` is not `1`. The same structural equality backs `includes`/`indexOf` element membership. (`$match` compares its subject against case values by equality too, but restricts both to scalars — see [Scalar Value Match](#scalar-value-match--match-cases-else).)

### Logic

| Function | Args     | Description |
| -------- | -------- | ----------- |
| `not`    | `(a)`    | logical not |
| `and`    | `(a, b)` | logical and |
| `or`     | `(a, b)` | logical or  |

### Type Checking

| Function   | Args  | Description                           |
| ---------- | ----- | ------------------------------------- |
| `isNull`   | `(a)` | is null                               |
| `isBool`   | `(a)` | is boolean                            |
| `isNumber` | `(a)` | is number                             |
| `isString` | `(a)` | is string                             |
| `isArray`  | `(a)` | is array                              |
| `isObject` | `(a)` | is plain object (not array, not null) |
| `isTask`   | `(a)` | is a task (a plain object with an `@task` string tag) |

### Type Coercion

| Function | Args  | Description                        |
| -------- | ----- | ---------------------------------- |
| `str`    | `(a)` | to string (serializes non-strings) |
| `num`    | `(a)` | to number (throws if unparseable)  |

### Arrays

| Function   | Args                 | Description                              |
| ---------- | -------------------- | ---------------------------------------- |
| `length`   | `(arr)`              | length (works on strings too)            |
| `head`     | `(arr)`              | first element                            |
| `last`     | `(arr)`              | last element (null if empty)             |
| `tail`     | `(arr)`              | all but first                            |
| `concat`   | `(...arrays)`        | concatenate arrays (variadic)            |
| `range`    | `(n)`                | `[0, 1, ..., n-1]`                       |
| `slice`    | `(arr, start, end?)` | slice                                    |
| `reverse`  | `(arr)`              | reversed copy                            |
| `take`     | `(arr, n)`           | first `n` elements; non-positive `n` gives `[]` |
| `drop`     | `(arr, n)`           | all but the first `n` elements; non-positive `n` returns a copy |
| `zip`      | `(left, right)`       | corresponding pairs, truncated to the shorter array |
| `unique`   | `(arr)`               | first occurrence of each structurally distinct value |
| `repeat`   | `(value, n)`          | repeat an array or string `n` times; `n` must be non-negative |
| `includes` | `(arr, value)`       | structural contains check (substring check on strings) |
| `indexOf`  | `(arr, value)`       | structural index of value, `null` if missing (substring index on strings) |
| `flatten`  | `(arr)`              | flatten one level                        |
| `setAt`    | `(arr, idx, value)`  | new array with element at idx replaced   |

### Strings

| Function     | Args           | Description                      |
| ------------ | -------------- | -------------------------------- |
| `upper`      | `(s)`          | uppercase                        |
| `lower`      | `(s)`          | lowercase                        |
| `trim`       | `(s)`          | trim whitespace                  |
| `strcat`     | `(...strings)` | concatenate strings              |
| `split`      | `(s, sep)`     | split string                     |
| `join`       | `(arr, sep)`   | join array with separator        |
| `startsWith` | `(s, prefix)`  | whether `s` starts with `prefix` |
| `endsWith`   | `(s, suffix)`  | whether `s` ends with `suffix`   |
| `replace`    | `(s, search, replacement)` | replace all literal, non-overlapping matches; `search` must be non-empty |
| `padStart`   | `(s, length, fill?)` | left-pad to a Unicode code-point length; fill defaults to a space |

### Regex

Patterns are plain strings. Flags are specified via inline `(?flags)` prefix: `i` (case-insensitive), `m` (multiline), `s` (dotall), `u` (Unicode). Example: `"(?i)hello"`.

Match results are objects with `match` (full matched text), `index` (start position), `groups` (positional captures, `null` for unmatched optional groups), and `named` (named capture groups, empty object if none).

| Function     | Args                          | Description                                                |
| ------------ | ----------------------------- | ---------------------------------------------------------- |
| `reTest`     | `(pattern, str)`              | true if pattern matches anywhere in str                    |
| `reMatch`    | `(pattern, str)`              | first match object, or `null`                              |
| `reMatchAll` | `(pattern, str)`              | array of all non-overlapping match objects                 |
| `reReplace`  | `(pattern, replacement, str)` | replace all matches. `$0` = full match, `$1`/`$2` = groups |
| `reSplit`    | `(pattern, str)`              | split string by pattern                                    |

`reReplaceWith` is a higher-order variant listed under [Higher-Order Functions](#higher-order-functions).

### Objects

| Function      | Args          | Description                        |
| ------------- | ------------- | ---------------------------------- |
| `keys`        | `(obj)`       | array of keys                      |
| `values`      | `(obj)`       | array of values                    |
| `entries`     | `(obj)`       | array of `[key, value]` pairs      |
| `fromEntries` | `(pairs)`     | object from `[key, value]` pairs   |
| `merge`       | `(a, b)`      | shallow merge (b wins on conflict) |
| `hasKey`      | `(obj, key)`  | key exists check                   |
| `pick`        | `(obj, keys)` | select specified keys              |
| `omit`        | `(obj, keys)` | exclude specified keys             |

### Higher-Order Functions

Higher-order functions can invoke json-fn callbacks. The callback argument can be a function reference (`{ "$fn": "name" }`), an inline function body, or a string name.

| Function        | Args                       | Description                                                                      |
| --------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `map`           | `(callback, arr)`          | map. Callback receives `(item, index)`.                                          |
| `filter`        | `(callback, arr)`          | filter. Callback receives `(item, index)`.                                       |
| `reduce`        | `(callback, init, arr)`    | reduce. Callback receives `(acc, item, index)`.                                  |
| `find`          | `(callback, arr)`          | first match or `null`. Callback receives `(item, index)`.                        |
| `findIndex`     | `(callback, arr)`          | index of first match or `null`. Callback receives `(item, index)`.               |
| `some`          | `(callback, arr)`          | any match. Callback receives `(item, index)`.                                    |
| `every`         | `(callback, arr)`          | all match. Callback receives `(item, index)`.                                    |
| `count`         | `(callback, arr)`          | number of matches. Callback receives `(item, index)`.                            |
| `sort`          | `(arr)` / `(comparator, arr)` | sorted copy. The default orders homogeneous numbers ascending or homogeneous strings by Unicode code point. A comparator receives `(a, b)` and returns a number. |
| `sortBy`        | `(keyFn, arr)`             | sorted copy by key function. keyFn receives `(item, index)`.                     |
| `flatMap`       | `(callback, arr)`          | map then flatten arrays one level; retain scalar results. Callback receives `(item, index)`. |
| `groupBy`       | `(keyFn, arr)`             | group into object. keyFn receives `(item, index)`, must return string or number. |
| `mapValues`     | `(callback, obj)`          | transform object values. Callback receives `(value, key)`.                       |
| `apply`         | `(fn, argsArray)`          | call `fn` with elements of `argsArray` as positional arguments.                  |
| `pipe`          | `(fns, init)`              | thread value through array of functions left-to-right.                           |
| `reReplaceWith` | `(pattern, callback, str)` | replace all regex matches via callback. Callback receives a match object.        |

At runtime, a callback may be an inline function, a function reference, or a
raw string name. The static checker contextually types bare inline functions
and checks typed function references; it does not resolve raw string names.
Bare inline callbacks may omit trailing arguments supplied by the builtin.
Referenced and `$sig`-annotated callbacks retain strict function arity, so use
a wrapper lambda when their declared parameters do not match the builtin's
callback shape.

`groupBy` converts numeric keys to strings before using them as object keys.
`flatMap` splices array callback results into the output and keeps non-array
results as single elements; nested arrays are therefore flattened by exactly
one level.
`reReplaceWith` callbacks statically return `string`, although the runtime
defensively stringifies other return values. `mapValues` is typed as a
string-keyed map and does not preserve exact input keys. `filter` and `find` do
not infer type predicates from callback logic.

### Tasks & Effects

These build and run **tasks** — the effect representation described under [Tasks & Effects](#tasks--effects). Constructors build inert, tagged records; `handle` interprets them in-language.

| Function  | Args              | Description                                                                                          |
| --------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `perform` | `(name, args)`    | build an `effect` task requesting effect `name` with arguments `args`                                |
| `pure`    | `(value)`         | build a completed task carrying `value`                                                              |
| `bind`    | `(task, k)`       | sequence: run `task`, pass its result to continuation `k`, which returns the next task               |
| `raise`   | `(err)`           | build a `raise` effect task (convenience for `perform("raise", [err])`)                              |
| `handle`  | `(task, clauses[, raw(resultSchema)])` | run `task`, interpreting effects via `clauses`; the optional annotation makes the handler total and runtime-validated |

`isTask(a)` (listed under [Type Checking](#type-checking)) reports whether a value is a task.

### Introspection

| Function | Args   | Description                                                                                                                                    |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `arity`  | `(fn)` | returns parameter count. For rest params, excludes the rest param. `null` for unknown functions. Argument is a function name (string) or body. |

### Debugging

| Function | Args              | Description                                                                             |
| -------- | ----------------- | --------------------------------------------------------------------------------------- |
| `log`    | `(value, label?)` | passes `value` and optional `label` to the host-configured logger, then returns `value` |

`log` is a tap-style debugging helper:

```json
{
  "$call": "map",
  "$args": [
    { "$params": ["x"], "$return": { "$call": "log", "$args": [{ "$var": "x" }, "item"] } },
    [1, 2, 3]
  ]
}
```

By default, `log` is inert and produces no output. Host integrations may pass a logger when constructing the standard library to capture or emit logs. The output destination and format are host-defined.

> **Note: lazy locals.** Because non-`$return` keys in a function body are [lazy](#lazy-local-variables), a `log` call placed in an unreferenced local is never evaluated. To log inside a function body, either put the `log` call in the path of `$return`, or reference the debug local from `$return` so it actually runs.

## HOF Argument Order

Higher-order functions take **callback first, data second**. This is consistent across all HOFs: `map(callback, arr)`, `filter(callback, arr)`, `reduce(callback, init, arr)`, etc.

## Patterns

### Calling a registered function

Register the function body in the function registry, call it by name:

```json
{ "$call": "myFunction", "$args": [1, 2, 3] }
```

### Inline anonymous function

Use a function body directly as the `$call` callee:

```json
{
  "$call": {
    "$params": ["x"],
    "$return": { "$call": "mul", "$args": [{ "$var": "x" }, { "$var": "x" }] }
  },
  "$args": [5]
}
```

### Pipeline (filter -> map -> reduce)

Use local variables to chain steps:

```json
{
  "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "evens": { "$call": "filter", "$args": [{ "$fn": "isEven" }, { "$var": "nums" }] },
  "doubled": { "$call": "map", "$args": [{ "$fn": "double" }, { "$var": "evens" }] },
  "$return": { "$call": "reduce", "$args": [{ "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

Or use `pipe`:

```json
{ "$call": "pipe", "$args": [[{ "$fn": "neg" }, { "$fn": "abs" }, { "$fn": "str" }], -5] }
```

### Currying / Partial Application

Return a function body from a function to capture arguments:

```json
{
  "$params": ["a"],
  "$return": {
    "$params": ["b"],
    "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
  }
}
```

### Dynamic Apply

Use `apply` to call a function with a dynamically constructed argument array:

```json
{ "$call": "apply", "$args": [{ "$var": "targetFn" }, { "$var": "collectedArgs" }] }
```

### Object Transformation

Use `entries` -> HOF -> `fromEntries` to transform objects:

```json
{
  "pairs": { "$call": "entries", "$args": [{ "$var": "obj" }] },
  "filtered": {
    "$call": "filter",
    "$args": [
      {
        "$params": ["pair"],
        "$return": { "$call": "gt", "$args": [{ "$get": 1, "$from": { "$var": "pair" } }, 3] }
      },
      { "$var": "pairs" }
    ]
  },
  "$return": { "$call": "fromEntries", "$args": [{ "$var": "filtered" }] }
}
```

## Execution Limits

### Circular Variable Dependencies

Lazy locals form a dependency graph resolved on demand. If resolving a local requires resolving itself — directly (`{ "x": { "$var": "x" } }`) or through a cycle (`a → b → a`) — evaluation errors instead of looping. The cycle is reported in the message, e.g.:

```
Circular variable dependency detected: a -> b -> a
```

This detection is part of the language: it is always on, needs no configuration, and is enforced by every implementation. It reports the first cycle reached, even when the cycle does not start at the first variable.

### Host-configured resource limits

Beyond the always-on circular check, hosts may cap the resources a program consumes. Two of these caps are **deterministic and part of the conformance spec**, so their observable behavior is guaranteed across implementations:

- **Fuel** (`maxFuel`) bounds total metered work; exceeding it errors with `Maximum fuel limit of N exceeded`.
- **Value size** (`maxValueSize`) bounds the length of any array or string a program produces; exceeding it errors with `Maximum value size of N exceeded`.

A third cap, **call depth** (`maxCallDepth`), guards recursion against host stack overflow and uses an implementation-defined default when unset. Hosts may additionally cancel a run cooperatively or impose a wall-clock timeout; those are host-only safety nets and, being non-deterministic, are **not** part of the conformance spec.

How limits are supplied, the per-language cancellation/timeout APIs, and default behavior are host concerns — see [`docs/host-integration.md`](./host-integration.md). For the normative cost model (exactly what each node and builtin charges), see [`docs/execution-limits.md`](./execution-limits.md).

## Constraints

- `$var` must be the sole key; its value is a plain variable name (no path notation, no `$get` sibling).
- `$get`/`$from` must be the only two keys; both are required. This is the only property-access form.
- `$if`/`$then`/`$else` must all be present, exactly three keys.
- `$cond` may have only `$cond` and optional `$else`; each entry must be a two-element array.
- `$match` must have `$match`, `$cases`, and `$else`; `$match` and case values must evaluate to scalar JSON values.
- `$and` must be the sole key; value must be an array of expressions.
- `$or` must be the sole key; value must be an array of expressions.
- `$raw` must be the sole key.
- A function call has exactly `$call` (the callee) and `$args` (an array of arguments) and no other keys.
- A function reference has `$fn` as its sole key; `$fn` is never an array.
- `$return` cannot coexist with `$call` or `$fn`.
- `$comment` (with a string value) is allowed as a sibling key in any expression form and does not count toward "sole key" / "exactly N keys" constraints. In plain data objects it is stripped from the output.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
