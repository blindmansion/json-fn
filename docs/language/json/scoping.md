# Scoping Rules

- Function parameters and runtime `$captures` create the function invocation
  scope.
- `$let` creates an expression-local recursive scope. Its names shadow function
  parameters, captures, outer lets, and module bindings in variable lookup.
  Literal function-body bindings additionally shadow callable registry entries.
- Variables resolve from the innermost binder outward. Parameter defaults are
  in the function invocation scope and can see captures, all parameter
  bindings/defaults, and outer/module scope, but not a `$let` nested later
  inside `$return`.

