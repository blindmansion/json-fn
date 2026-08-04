# Module Scope and Scoping Rules

## Module scope

A whole program module is a distinct **object mapping names to expressions**.
When a host links such an object and chooses an entry point, module entries form
a persistent recursive registry:

- Top-level **constants** (`SIZE`, `OFFSETS`, …) are visible via `$var` throughout the module.
- Top-level **functions** are callable via `$call` and, being bindings, are also `$var`-visible as function values (so they can be passed by name to higher-order functions).
- Constants are lazy, memoized, order-independent, mutually recursive, and
  cycle-checked.
- Literal function entries are persistent named definitions. They are callable
  by name and visible as function values, but are not copied into escaping
  closures' `$captures`.

```json
{
  "W": 20,
  "H": 12,
  "SIZE": { "$call": "mul", "$args": [{ "$var": "W" }, { "$var": "H" }] },
  "area": {
    "$sig": { "required": [], "optional": [], "returns": { "type": "integer" } },
    "$params": [],
    "$return": { "$var": "SIZE" }
  }
}
```

Running this program with entry `area` returns `240`: the top-level constant `SIZE` (itself defined in terms of `W` and `H`) is read as a plain `$var`, no nullary-function workaround required.

## The boundary rule

The module scope composes with the host-supplied registry (stdlib + native builtins) by **one rule**:

> The module object is the **outermost lexical frame**; the host/stdlib registry is its **parent frame**. Callee (`$call`) and `$var` resolution are unchanged except that they now walk one additional frame.

The module registry is not a function body and is not a `$let` encoding.
Function bodies have a closed structural schema; module roots instead own named
entries and may additionally own `$types`. Consequences:

- **Shadowing.** A module binding shadows a same-named registry entry (stdlib is the parent frame).
- **Inner binders still win.** A function's `$params`, runtime `$captures`, or
  an expression `$let` shadows a module constant of the same name.
- **Lisp-2 asymmetry (by syntax, not runtime type).** Only a binding whose value is _literally_ a function body (has a `$return` key) becomes callable in `$call` position. So a module _constant_ named `map` shadows `$var map` but **not** a `$call` to `map` (which still resolves the stdlib `map`), even if that constant happens to evaluate to a function; a module _function_ named `map` shadows **both**.

This is a single outermost frame, not a module _system_: there is no `import` / `export`, no multiple modules, and no re-exports.

## Scoping rules

- Function parameters and runtime `$captures` create the function invocation
  scope.
- `$let` creates an expression-local recursive scope. Its names shadow function
  parameters, captures, outer lets, and module bindings in variable lookup.
  Literal function-body bindings additionally shadow callable registry entries.
- Variables resolve from the innermost binder outward. Parameter defaults are
  in the function invocation scope and can see captures, all parameter
  bindings/defaults, and outer/module scope, but not a `$let` nested later
  inside `$return`.

