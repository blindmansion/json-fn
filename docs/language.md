# json-fn Language Reference

json-fn is a JSON-structured expression language. Programs are JSON values evaluated by a tree-walking interpreter. All expressions are valid JSON.

## Expression Types

Every JSON value is an expression. The interpreter determines its type by shape:

### Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

### Arrays

Each element is evaluated recursively. `[1, { "$fn": ["add", 2, 3] }]` evaluates to `[1, 5]`.

### Plain Objects

Each value is evaluated recursively (keys are not). `{ "x": { "$fn": ["add", 1, 2] } }` evaluates to `{ "x": 3 }`.

### Function Call — `{ $fn: [...] }`

Calls a function. `$fn` is an array where the first element is the function (a name, body, or expression that resolves to one) and the remaining elements are arguments.

```json
{ "$fn": ["add", 3, 4] }
```

Nested calls — arguments can themselves be calls:

```json
{
  "$fn": ["mul", { "$fn": ["add", 2, 3] }, { "$fn": ["sub", 10, 4] }]
}
```

Zero-argument calls use a single-element array:

```json
{ "$fn": ["myFunction"] }
```

### Function Reference — `{ $fn }` (non-array)

When `$fn` is not an array, it evaluates the value and returns the result (a string name or function body) without calling it. Used to pass functions as values to higher-order functions.

```json
{ "$fn": "double" }
```

### Variable Reference — `{ $var }`

Resolves a variable by name. `$var` must be the sole key, and its value is a plain variable name looked up directly in scope — there is no dot/bracket path notation and no `$get` sibling.

```json
{ "$var": "x" }
```

### Property Access — `{ $get, $from }`

All property access uses `$get`/`$from`. `$from` evaluates to the target and `$get` evaluates to the key read from it:

```json
{ "$get": "name", "$from": { "$var": "person" } }
{ "$get": 1, "$from": { "$var": "items" } }
{ "$get": ["address", "city"], "$from": { "$var": "person" } }
{ "$get": { "$var": "fieldName" }, "$from": { "$var": "data" } }
{ "$get": 0, "$from": { "$fn": ["concat", [10], [20]] } }
```

`$get` evaluates to one of:

- a **string** key — reads an object property (`null` if the key is missing);
- a **number** index — reads an array element, or a character from a string (`null` if out of bounds);
- an **array** — a static path walked segment by segment, applying the per-segment rules above at each step.

`$from` may be any expression: a variable, a function result, a literal, or another `$get`/`$from` chain (nest them to walk deeper). Path traversal into a `null` or missing intermediate value returns `null`; a non-numeric `$get` on a string errors, as does a `$get` whose target is not an object, array, or string. `$get`/`$from` must be the only two keys.

### Function Body — `{ $return, ... }`

Defines a function. Required key: `$return` (the expression to evaluate when called). Optional key: `$params` (array of strings). All other keys are **lazy local variables** — evaluated on first access.

```json
{
  "$params": ["n"],
  "remainder": { "$fn": ["mod", { "$var": "n" }, 2] },
  "$return": { "$eq": [{ "$var": "remainder" }, 0] }
}
```

When a function body appears in expression position (not as the top-level target of a call), it is treated as a closure — outer variables are substituted into it.

### Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$gt": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

### Multi-branch Conditional — `{ $cond }`

Array of `[condition, result]` pairs. First truthy condition wins. If no condition matches, optional `$else` is evaluated and returned; without `$else`, the interpreter errors. Only the matched result or `$else` is evaluated.

```json
{
  "$cond": [
    [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$eq": [{ "$var": "n" }, 0] }, "zero"]
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
    ["show", { "$fn": ["showResult", { "$var": "state" }] }],
    ["reset", { "$fn": ["resetResult"] }],
    ["help", { "$fn": ["helpResult"] }]
  ],
  "$else": { "$fn": ["moveResult", { "$var": "state" }, { "$var": "argv" }] }
}
```

### Short-Circuit And — `{ $and }`

Array of expressions evaluated left-to-right. Returns the first falsy value, or the last value if all are truthy. Short-circuits (stops evaluating after the first falsy result).

```json
{
  "$and": [{ "$gt": [{ "$var": "x" }, 0] }, { "$lt": [{ "$var": "x" }, 100] }, "in range"]
}
```

Unlike the stdlib `and` function, `$and` does **not** evaluate all its operands — it is a language-level special form. It is also variadic (any number of operands).

### Short-Circuit Or — `{ $or }`

Array of expressions evaluated left-to-right. Returns the first truthy value, or the last value if all are falsy. Short-circuits (stops evaluating after the first truthy result).

```json
{ "$or": [{ "$var": "cached" }, { "$fn": ["compute", { "$var": "x" }] }] }
```

### Comparison Shorthands — `{ $eq }`, `{ $neq }`, `{ $lt }`, `{ $lte }`, `{ $gt }`, `{ $gte }`

Each comparison shorthand takes an array of exactly two expressions, evaluates both, and returns a boolean. They are concise equivalents of the stdlib comparison functions.

```json
{ "$eq": [{ "$var": "status" }, "playing"] }
{ "$gte": [{ "$var": "score" }, 10] }
```

`$eq` and `$neq` use strict equality, not deep structural equality.

### Not Shorthand — `{ $not }`

Evaluates the expression and returns its logical negation using normal json-fn truthiness.

```json
{ "$not": { "$eq": [{ "$var": "status" }, "playing"] } }
```

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
      [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
      [{ "$eq": [{ "$var": "n" }, 0] }, "zero"],
      [true, "positive"]
    ]
  }
}
```

Rules:

- The value **must be a string** to be recognized as a comment. Non-string values are treated as normal keys (and will typically cause "expression cannot have other properties" errors in expression forms).
- Allowed as a sibling key in any expression form (`$fn`, `$var`, `$if`/`$then`/`$else`, `$cond`, `$and`, `$or`, comparison shorthands, `$not`, `$raw`, `$get`/`$from`, `$return`/`$params`/locals).
- In plain data objects, `$comment` is stripped from the output. To preserve a literal `$comment` key in data, wrap with `$raw`.
- Inside `$raw`, the entire value is returned verbatim — `$comment` is preserved.
- Closures preserve `$comment` when a function body is returned as a value.

## Function Bodies

A function body has `$return` and optionally `$params`. All other keys are lazy locals.

### Parameters — `$params`

Array of strings. Arguments are bound positionally.

```json
{
  "$params": ["a", "b"],
  "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] }
}
```

Missing arguments default to `null`.

### Rest Parameters

A parameter starting with `...` collects remaining arguments into an array.

```json
{
  "$params": ["first", "...rest"],
  "$return": { "$var": "rest" }
}
```

Called with args `[1, 2, 3]`: `first` = `1`, `rest` = `[2, 3]`.

### Lazy Local Variables

Any key other than `$return` and `$params` defines a local variable. Locals are evaluated lazily (on first `$var` access) and can reference each other and `$params`. Key order within a function body does not affect evaluation — locals form a dependency graph resolved on demand, so the body behaves identically regardless of how a JSON parser orders the keys.

```json
{
  "$params": ["x", "y"],
  "sum": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$fn": ["mul", { "$var": "sum" }, 2] },
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
    "$return": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$fn": ["add", 10, { "$var": "y" }] }
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
      "$if": { "$lte": [{ "$var": "x" }, 0] },
      "$then": { "$var": "base" },
      "$else": { "$fn": ["go", { "$fn": ["sub", { "$var": "x" }, 1] }] }
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
      "$if": { "$lte": [{ "$var": "x" }, 0] },
      "$then": 42,
      "$else": { "$fn": ["go", { "$fn": ["sub", { "$var": "x" }, 1] }] }
    }
  },
  "$return": {
    "$if": { "$lte": [{ "$var": "x" }, 0] },
    "$then": 42,
    "$else": { "$fn": ["go", { "$fn": ["sub", { "$var": "x" }, 1] }] }
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
    "$if": { "$lte": [{ "$var": "n" }, 1] },
    "$then": 1,
    "$else": {
      "$fn": ["mul", { "$var": "n" }, { "$fn": ["fact", { "$fn": ["sub", { "$var": "n" }, 1] }] }]
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
      "$if": { "$lte": [{ "$var": "x" }, 1] },
      "$then": 1,
      "$else": {
        "$fn": ["mul", { "$var": "x" }, { "$fn": ["fact", { "$fn": ["sub", { "$var": "x" }, 1] }] }]
      }
    }
  },
  "$return": { "$fn": ["fact", { "$var": "n" }] }
}
```

Local function names can shadow global registry functions and do not leak into parent or sibling scopes.

## Module Scope

A whole program is an **object mapping names to expressions** — the same shape as a function body's locals. When a host runs such an object as a program (choosing an entry point to invoke), that object is itself a **recursive, lazy binding scope**, identical in semantics to the locals inside a function body:

- Top-level **constants** (`SIZE`, `OFFSETS`, …) are visible via `$var` throughout the module.
- Top-level **functions** are callable via `$fn` and, being bindings, are also `$var`-visible as function values (so they can be passed by name to higher-order functions).
- Bindings are lazy (evaluated on first reference, then memoized), order-independent, mutually recursive, and cycle-checked — exactly like locals.

```json
{
  "W": 20,
  "H": 12,
  "SIZE": { "$fn": ["mul", { "$var": "W" }, { "$var": "H" }] },
  "area": { "$return": { "$var": "SIZE" } }
}
```

Running this program with entry `area` returns `240`: the top-level constant `SIZE` (itself defined in terms of `W` and `H`) is read as a plain `$var`, no nullary-function workaround required.

### The boundary rule

The module scope composes with the host-supplied registry (stdlib + native builtins) by **one rule**:

> The module object is the **outermost lexical frame**; the host/stdlib registry is its **parent frame**. `$fn` and `$var` resolution are unchanged except that they now walk one additional frame.

Consequences:

- **Shadowing.** A module binding shadows a same-named registry entry (stdlib is the parent frame).
- **Inner binders still win.** A function's `$params` or locals shadow a module constant of the same name, at any nesting depth — module scope is just the outermost link in the same chain described under [Scoping Rules](#scoping-rules).
- **Lisp-2 asymmetry (by syntax, not runtime type).** Only a binding whose value is _literally_ a function body (has a `$return` key) becomes `$fn`-callable. So a module _constant_ named `map` shadows `$var map` but **not** `$fn map` (which still resolves the stdlib `map`), even if that constant happens to evaluate to a function; a module _function_ named `map` shadows **both**.

This is a single outermost frame, not a module _system_: there is no `import` / `export`, no multiple modules, and no re-exports.

## Dynamic Dispatch

The first element of `$fn` can be a `$var` reference or any expression that evaluates to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$fn": [{ "$var": "fnName" }, 3, 4] }
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
{ "@task": "bind", "task": { "@task": "pure", "value": 1 }, "then": { "$params": ["x"], "$return": { "$fn": ["pure", { "$var": "x" }] } } }
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

Malformed tasks (e.g. a `bind` whose `then` is not a function, or an `effect` with a non-string `name`) are rejected as ordinary **guest-visible evaluation errors** when the task is run — never as host-language exceptions.

### The suspended form

Running a task normalizes it — walking the `bind` spine — to exactly one of two shapes. This pair is the stable contract shared by `handle`, the host trampoline, and durable storage:

```json
{ "done": 42 }
{ "pending": { "name": "http.get", "args": ["https://example.com"], "resume": { "$params": ["__v"], "$return": "..." } } }
```

`resume` is an ordinary self-contained closure `(value) => <task>`: apply it to the effect's result to continue. Because escaping-closure capture keeps it self-contained, a `pending` record is plain JSON — persist it, ship it across a process boundary, print it as shorthand, or apply it **more than once** (multi-shot).

### `handle` — interpreting effects in-language

`handle(task, clauses)` runs a task, dispatching each effect it performs to a matching clause in the `clauses` record. This is a pure, in-language interpreter for effects — no host involved — which is what makes effectful code testable.

Clause lookup is by effect name:

- A **named clause** `"http.get": (url, resume) => …` receives the effect's args spread positionally, then `resume` last.
- The reserved **`"*"` wildcard** clause `"*": (eff, resume) => …` catches any otherwise-unmatched effect and receives `eff = { name, args }` plus `resume`.
- The reserved **`"return"` clause** `"return": (v) => …` runs when the task completes normally with value `v`; its result is final and is **not** re-interpreted by this handler. Without a `"return"` clause, `handle` returns the completion value directly.

`resume` is itself plain JSON built by `handle`, so continuations stay serializable mid-handle and multi-shot resumption is free: calling `resume` twice re-runs the rest of the task twice (the basis for nondeterminism, retry, and backtracking combinators).

**Bubbling.** An effect with no matching clause (and no `"*"`) is *not* an error: `handle` re-performs it, wrapping the surrounding continuation so it re-enters the same handler afterward. The effect bubbles outward to the next enclosing `handle`, and ultimately to the host. This is what lets a handler discharge only the effects it cares about while staying transparent to the rest of the effect set.

```jfn
handle greet(mockIo()) with {
  "io.readLine": (resume) => resume("world"),
  "io.print":    (msg, resume) => resume(null)
}
```

Handler clauses are invoked through the normal call path, so fuel and call-depth metering apply; task normalization additionally charges fuel per interpreted node.

### Host trampoline

`handle` interprets effects *in-language*; to connect a task to the real world, a host drives it with `runTask` (in TypeScript, exported from the package):

```ts
const result = await runTask(module, "main", [], registry, {
  "io.readLine": async () => prompt(),
  "io.print": async (msg) => { console.log(msg); },
}, limits);
```

The host is the *outermost handler*: any effect that no in-language `handle` discharged bubbles all the way out to `runTask`, which

- returns the value on `{ done }`;
- throws `TaskRaiseError` (carrying the guest payload) for an unhandled `raise`;
- throws `UnhandledEffectError` for an effect with no capability;
- otherwise `await`s the capability, applies `resume` to its result, and loops.

**Durable suspend/resume.** Because a `pending` task is plain JSON, a host can `serializeTask` it, store it, and later `hydrateTask` + resume — even in a different process. `hydrateTask` restores the inertness marks that keep embedded tasks opaque to the evaluator.

**Static admission.** `requiredCapabilities(module | task)` walks the JSON and returns the effect names a program could ever perform, as `{ names, dynamic }`. A host can enumerate what a program might ask for *before* running it and reject at admission time rather than hitting `UnhandledEffectError` mid-run. It is a conservative over-approximation — it does **not** subtract effects an in-language `handle` discharges — and sets `dynamic: true` when a `perform` name is not a literal string.

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
| `mod`    | `(a, b)` | `a % b`                  |
| `abs`    | `(a)`    | absolute value           |
| `neg`    | `(a)`    | `-a`                     |
| `floor`  | `(a)`    | floor                    |
| `ceil`   | `(a)`    | ceiling                  |
| `round`  | `(a)`    | round                    |
| `max`    | `(arr)`  | max of array             |
| `min`    | `(arr)`  | min of array             |

### Comparison

| Function  | Args     | Description                |
| --------- | -------- | -------------------------- |
| `eq`      | `(a, b)` | strict equality            |
| `neq`     | `(a, b)` | strict inequality          |
| `jsonEq`  | `(a, b)` | structural JSON equality   |
| `jsonNeq` | `(a, b)` | structural JSON inequality |
| `gt`      | `(a, b)` | `a > b`                    |
| `gte`     | `(a, b)` | `a >= b`                   |
| `lt`      | `(a, b)` | `a < b`                    |
| `lte`     | `(a, b)` | `a <= b`                   |

`jsonEq` and `jsonNeq` compare arrays and objects recursively; object key order does not matter. They do not coerce types, so `true` is not `1` and `"1"` is not `1`.

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
| `includes` | `(arr, value)`       | strict contains check (works on strings) |
| `indexOf`  | `(arr, value)`       | strict index of value (-1 if missing)    |
| `flatten`  | `(arr)`              | flatten one level                        |
| `setAt`    | `(arr, idx, value)`  | new array with element at idx replaced   |

### Strings

| Function | Args           | Description               |
| -------- | -------------- | ------------------------- |
| `upper`  | `(s)`          | uppercase                 |
| `lower`  | `(s)`          | lowercase                 |
| `trim`   | `(s)`          | trim whitespace           |
| `strcat` | `(...strings)` | concatenate strings       |
| `split`  | `(s, sep)`     | split string              |
| `join`   | `(arr, sep)`   | join array with separator |

### Regex

Patterns are plain strings. Flags are specified via inline `(?flags)` prefix: `i` (case-insensitive), `m` (multiline), `s` (dotall). Example: `"(?i)hello"`.

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
| `findIndex`     | `(callback, arr)`          | index of first match or `-1`. Callback receives `(item, index)`.                 |
| `some`          | `(callback, arr)`          | any match. Callback receives `(item, index)`.                                    |
| `every`         | `(callback, arr)`          | all match. Callback receives `(item, index)`.                                    |
| `sort`          | `(comparator, arr)`        | sorted copy. Comparator receives `(a, b)`, returns number.                       |
| `sortBy`        | `(keyFn, arr)`             | sorted copy by key function. keyFn receives `(item, index)`.                     |
| `flatMap`       | `(callback, arr)`          | map then flatten one level. Callback receives `(item, index)`.                   |
| `groupBy`       | `(keyFn, arr)`             | group into object. keyFn receives `(item, index)`, must return string or number. |
| `mapValues`     | `(callback, obj)`          | transform object values. Callback receives `(value, key)`.                       |
| `apply`         | `(fn, argsArray)`          | call `fn` with elements of `argsArray` as positional arguments.                  |
| `pipe`          | `(fns, init)`              | thread value through array of functions left-to-right.                           |
| `reReplaceWith` | `(pattern, callback, str)` | replace all regex matches via callback. Callback receives a match object.        |

### Tasks & Effects

These build and run **tasks** — the effect representation described under [Tasks & Effects](#tasks--effects). Constructors build inert, tagged records; `handle` interprets them in-language.

| Function  | Args              | Description                                                                                          |
| --------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `perform` | `(name, args)`    | build an `effect` task requesting effect `name` with arguments `args`                                |
| `pure`    | `(value)`         | build a completed task carrying `value`                                                              |
| `bind`    | `(task, k)`       | sequence: run `task`, pass its result to continuation `k`, which returns the next task               |
| `raise`   | `(err)`           | build a `raise` effect task (convenience for `perform("raise", [err])`)                              |
| `handle`  | `(task, clauses)` | run `task`, interpreting each effect via the `clauses` record; unmatched effects bubble outward      |

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
  "$fn": [
    "map",
    { "$params": ["x"], "$return": { "$fn": ["log", { "$var": "x" }, "item"] } },
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
{ "$fn": ["myFunction", 1, 2, 3] }
```

### Inline anonymous function

Use a function body directly as the first element of `$fn`:

```json
{
  "$fn": [
    {
      "$params": ["x"],
      "$return": { "$fn": ["mul", { "$var": "x" }, { "$var": "x" }] }
    },
    5
  ]
}
```

### Pipeline (filter -> map -> reduce)

Use local variables to chain steps:

```json
{
  "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "evens": { "$fn": ["filter", { "$fn": "isEven" }, { "$var": "nums" }] },
  "doubled": { "$fn": ["map", { "$fn": "double" }, { "$var": "evens" }] },
  "$return": { "$fn": ["reduce", { "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

Or use `pipe`:

```json
{ "$fn": ["pipe", [{ "$fn": "neg" }, { "$fn": "abs" }, { "$fn": "str" }], -5] }
```

### Currying / Partial Application

Return a function body from a function to capture arguments:

```json
{
  "$params": ["a"],
  "$return": {
    "$params": ["b"],
    "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] }
  }
}
```

### Dynamic Apply

Use `apply` to call a function with a dynamically constructed argument array:

```json
{ "$fn": ["apply", { "$var": "targetFn" }, { "$var": "collectedArgs" }] }
```

### Object Transformation

Use `entries` -> HOF -> `fromEntries` to transform objects:

```json
{
  "pairs": { "$fn": ["entries", { "$var": "obj" }] },
  "filtered": {
    "$fn": [
      "filter",
      {
        "$params": ["pair"],
        "$return": { "$gt": [{ "$get": 1, "$from": { "$var": "pair" } }, 3] }
      },
      { "$var": "pairs" }
    ]
  },
  "$return": { "$fn": ["fromEntries", { "$var": "filtered" }] }
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
- `$eq`, `$neq`, `$lt`, `$lte`, `$gt`, and `$gte` must be the sole key; value must be an array of exactly two expressions.
- `$not` must be the sole key.
- `$raw` must be the sole key.
- `$fn` as an array (function call) must be the sole key. `$fn` as a non-array (reference) must also be the sole key.
- `$return` cannot coexist with `$fn`.
- `$comment` (with a string value) is allowed as a sibling key in any expression form and does not count toward "sole key" / "exactly N keys" constraints. In plain data objects it is stripped from the output.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
