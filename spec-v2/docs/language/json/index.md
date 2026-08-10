# JSON language reference

json-fn programs are JSON values. This reference defines their forms,
evaluation, scope, static checking, effects, and limits.

## Contents

- [Expressions](expressions.md) — values, calls, bindings, access, control flow,
  and structural rules.
- [Functions](functions.md) — parameters, inline types and the interface
  derivation, object-pattern lowering, and recursion.
- [Closures](closures.md) — captured values and local functions.
- [Modules and scope](modules.md) — module bindings and name resolution.
- [Flow narrowing](narrowing.md) — branch-sensitive type refinement.
- [Tasks and effects](tasks-and-effects.md) — pure effect descriptions,
  handlers, and suspension.
- [Execution limits](execution-limits.md) — cycles and resource limits.
- [Standard library](standard-library.md) — semantic rules shared by builtin
  groups.
