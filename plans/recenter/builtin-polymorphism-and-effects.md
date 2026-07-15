# Builtin polymorphism, effect contracts, and guest generics

This note records the architectural findings behind the `handle` discussion in
§6 of [`../recenter-plan.md`](../recenter-plan.md). It separates three questions
that are easy to conflate:

1. whether the language-agnostic builtin table may use polymorphic signatures;
2. whether an embedding operator may declare typed effect contracts; and
3. whether guest `.jfn` code may declare its own generic functions and types.

They have different users, costs, and consequences. Rejecting the third does
not require rejecting the first two.

## Current architecture

### Builtins already have a private generic dialect

`spec/builtins.json` already supports builtin-only `typeParams` and `$tvar`
templates. The TypeScript checker instantiates them at each call site, and no
`$tvar` escapes into an inferred guest type. Ordered overloads cover ad-hoc
polymorphism; `{ "rule": "..." }` and `CODE_RETURNS` are escape hatches for
signatures that are not substitution templates.

This is deliberately not the user-facing type language. It is shared
specification data consumed by each checker implementation.

The current instantiator handles variables in bare positions, arrays, and
function types. It cannot bind a variable reached through tuple or object
structure on the argument side. That implementation gap forced code-return
rules for `fromEntries`, `values`, and `entries`.

Even a complete structural matcher would not express every builtin:

- `merge` computes a structural object spread;
- `pipe` folds a heterogeneous sequence of function types;
- `apply` projects a callable from a value and an argument tuple; and
- `handle` depends on effect semantics, handler coverage, and/or an explicit
  contract.

Encoding those operations in data would require a schema-computation or
dependent-type DSL, not merely ordinary generics.

### `Task` is opaque today

At runtime, a task is an inert tagged JSON record containing a pure value, an
effect request, or a bind continuation. Statically, `Task` is only the coarse
tagged-record schema from `spec/builtins.json`. It does not record a completion
type, effect argument types, or the set of effects that may remain.

`perform` accepts a string and an array; the host capability table maps strings
to TypeScript functions. There is currently no shared schema table connecting
an effect name to its argument and result types. `requiredCapabilities` provides
conservative name-level admission checking, not type checking.

The two-argument `handle` still synthesizes top and may return either a final
value or a residual `Task` when an unhandled effect bubbles. The implemented
three-argument form is different: it takes `raw(resultSchema)`, synthesizes that
schema, rejects bubbling, and validates its result at runtime.

### Guest signatures are monomorphic

Guest types are concrete JSON Schemas plus the distinguished `$fnType` node.
This keeps structural subsumption small and lets a concrete annotation also be
a runtime validator. User-authored `$tvar`s, generic aliases, polymorphic
function values, and applied generic references are not part of the shorthand
gate.

## Resolved direction

### Keep builtin polymorphism private and make it more complete

Builtin definitions may express polymorphism even though guest code may not.
Extend the shared instantiation algorithm to bind `$tvar`s through tuple and
object shapes where that produces honest argument/return relationships. This
is checker plumbing, not an expansion of the guest type universe.

Keep named code rules for genuinely structural or control-flow-dependent
returns. The language-agnostic table should remain the common signature floor;
it should not grow a general schema-programming language merely to eliminate
small per-implementation algorithms.

### Do not add general guest generics as part of recenter

The current problems do not justify user-authored `<T>` declarations. Full
guest polymorphism would require:

- generic syntax and a canonical representation;
- checking function bodies under abstract type variables;
- call-site inference and explicit instantiation rules;
- semantics for higher-order polymorphic values;
- generic aliases, applied references, recursion, and variance rules if aliases
  are included;
- printing and round-tripping typed modules; and
- a decision about runtime validation when a signature is not yet concrete.

Most present failures instead come from incomplete bidirectional checking,
silent degradation, builtin-template matching gaps, and `handle` returning top.
Those should be repaired first.

If guest generics are reconsidered later, the smallest coherent first step is
generic function signatures only, instantiated to concrete schemas at calls.
Generic aliases and polymorphic `Task`/effect rows are separate later tiers.

### Treat operator-defined effects as environment contracts

An embedding operator should be able to supply a language-agnostic effect
manifest mapping each effect name to:

- its positional argument schemas; and
- its result schema.

The same manifest should serve two sides of the sandbox boundary:

- **checker:** a literal `perform("name", args)` checks its arguments and can
  recover the effect's result contract;
- **host runtime:** `runTask` validates outgoing effect arguments before
  invoking the capability and validates the capability's returned value before
  resuming guest code.

This is environment configuration, not guest reflection or guest-defined
polymorphism. Dynamic effect names cannot be resolved statically and should
remain a reported degradation or an operator-rejectable admission case.

The manifest should complement, not replace, capability records in guest code:
capability records describe the API visible to a program, while the operator
manifest is the authoritative contract for the host implementations behind
effect names.

### Keep concrete boundary annotations

Concrete function signatures and a concrete result annotation on `handle`
remain the preferred near-term discharge mechanism. The checker may trust a
concrete schema only where the runtime validates the corresponding untrusted
value.

The annotated-`handle` work has now introduced the first shared runtime
boundary implementation:

- `typescript/src/runtime-contract.ts` validates concrete data using the same
  schema vocabulary as the checker;
- function schemas install serializable callable wrappers that validate
  eventual arguments and return values;
- active module `$types` are threaded through evaluator calls in a runtime
  context and resolve `$ref`s during validation; and
- `RuntimeContractError` distinguishes a failed declared boundary, including
  an unmatched effect in a total handler.

This path is currently wired to annotated `handle`, not generally to host
inputs, outputs, or capabilities. The effect-manifest work should reuse and
generalize it rather than introduce a second validator.

### Lessons from the completed `handle` implementation

Several implementation details constrain the larger builtin/effect work:

1. **Static and runtime definitions need one explicit merge rule.** The checker
   sees builtin `$defs` plus module `$types`; the runtime contract context
   currently carries module `$types` only. An operator manifest may introduce a
   third definition pool. Its precedence, ownership, and serialization must be
   settled rather than letting checker and runtime resolution drift.
2. **Builtins now have a runtime context channel.** The builtin call interface
   receives active runtime definitions separately from evaluated arguments.
   Manifest-backed builtins should use that channel (or a deliberate successor)
   instead of hiding schemas in the function registry or guest values.
3. **Callable validation transforms values.** A function contract cannot be a
   boolean shape test: it returns a wrapper that checks later calls. Any shared
   host-boundary API therefore needs a validator that can return a contracted
   value, not only `valueSatisfies(...)`.
4. **Contract wrappers must be evaluator-native and serializable.** The
   implementation stores a target plus schema/definitions in an ordinary JSON
   function body and dispatches the target directly. It deliberately does not
   call a named helper such as `apply`, because guest/module names can shadow
   builtins. Capability-result wrappers should preserve the same property.
5. **`raw(schema)` is transport, not the runtime value shape.** Evaluation
   unwraps the third argument before `handle` receives it. Future builtin rules
   should distinguish canonical AST transport from the evaluated builtin API
   when specifying schema-valued arguments.
6. **Concrete examples confirm the remaining precision gap.** Typed thermostat
   and dungeon handlers now have sound `(ScriptState) -> Report` contracts and
   check with zero errors, but their `bind` continuations and handler clauses
   still report degradation because opaque `Task` carries no completion type.
   Improving ordinary `$tvar` matching alone will not recover that information;
   the manifest needs specialized task-result propagation (or an equivalent
   code rule) if callback parameters are to become precise.

The host examples also make the boundary distinction concrete: `runTask`
currently receives a bare map from effect names to TypeScript functions.
Nothing automatically injects schemas from that table, and guest capability
record types are not authoritative for the host. The operator manifest remains
the missing source of truth for endowed capability argument/result contracts.

## Open decisions

### Effect manifest representation and ownership

Decide:

- whether the manifest lives in `spec/`, module metadata, or only host
  configuration;
- how host-owned named schemas and module `$types` are referenced or merged;
- whether effect names are globally qualified;
- how implementations consume the same manifest without coupling it to
  TypeScript capability functions; and
- whether unknown and dynamic effects are errors, degradations, or selected by
  host policy.

The manifest must remain data, must contain only concrete schemas from the
tractable fragment, and must be usable for runtime validation. It should also
define how its named schemas merge with builtin `$defs` and module `$types` in
both checker and runtime contexts.

### Specialized task result indexing

A specialized checker node such as `Task<A>` could thread completion types
without enabling arbitrary guest generics:

- `pure(A) -> Task<A>`;
- `bind(Task<A>, (A) -> Task<B>) -> Task<B>`;
- manifest-backed `perform("name", args) -> Task<ResultOfName>`;
- `raise(E) -> Task<never>` (or another deliberately chosen bottom); and
- a total `handle` could eliminate the `Task` layer.

This index can be static/erased; the existing runtime task representation need
not change. It would be a distinguished type constructor like `$fnType`, not a
JSON Schema and not proof of parametricity.

Open questions:

- Is it checker-internal only, or may guest signatures write concrete
  `Task<Report>`?
- Does a residual task preserve only its completion type, or also an effect set?
- How are unannotated continuations and stored task values represented?
- Is the precision worth adding a second non-schema type node?

This is optional follow-up work, not a prerequisite for the recenter milestone.

### `handle` totality and bubbling — resolved for recenter

The existing two-argument `handle(task, handlers)` remains partial: unmatched
effects bubble and its static result stays top. The new annotated form is total:
an unmatched effect is a runtime contract failure, so no residual task is
presented as the declared result.

The shorthand is `handle task -> ResultType with { ... }`, lowering to a third
`raw(resultSchema)` argument on the builtin call. The schema types the immediate
result of `handle`. State-handler encodings return a function at that point, so
their annotation is a function type whose eventual result is `Report`, not
`Report` itself. Runtime support now enforces callable boundary contracts as
well as concrete data schemas. See [`effects-handle.md`](effects-handle.md) for
the canonical shape and implementation status.

Effect-set tracking could eventually prove totality statically, but it is not
required for this contract and remains outside recenter.

### General guest generics

Deferred, not permanently forbidden. Before reopening, require concrete use
cases that cannot be handled by builtin polymorphism, effect manifests,
specialized task indexing, or monomorphic boundary annotations. Also require a
typed shorthand printer: generic syntax is not viable for agent authors unless
typed modules round-trip.

## Recommended sequence

1. Finish the remaining recenter checker work.
2. Extend builtin template matching through tuples and objects; retain code
   rules where the return is a true schema computation.
3. ~~Implement the resolved total annotated-`handle` form and its runtime
   contract.~~ Done; reuse its runtime contract/context path.
4. Design the operator effect manifest and wire checker plus host validation
   from the same data.
5. Evaluate specialized `Task<A>` indexing using real effectful examples.
6. Reconsider generic guest functions only if concrete examples still lose
   important type information.
