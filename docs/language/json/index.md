# json-fn Language Reference

json-fn is a JSON-structured expression language. Programs are JSON values evaluated by a tree-walking interpreter. All expressions are valid JSON.


## Contents

### Core semantics

- [Expression Types](expressions.md) — expression forms, dynamic dispatch, and
  structural constraints.
- [Function Bodies](functions.md) — parameters, local bindings, and recursion.
- [Closures](closures.md)
- [Module Scope and Scoping Rules](modules.md)
- [Flow Narrowing](narrowing.md)

### Effects and runtime

- [Tasks & Effects](tasks-and-effects.md)
- [Execution Limits](execution-limits.md)

### Library and usage

- [Standard Library](standard-library.md) — builtin semantic notes, including
  higher-order function conventions.
- [Patterns](patterns.md)
