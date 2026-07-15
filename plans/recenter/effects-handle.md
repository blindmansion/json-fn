# Effects — annotated `handle` and totality

Overview for §6 of `plans/recenter-plan.md`. Goal: give `handle` a declared
result-type annotation the checker trusts statically and the runtime validates
at the boundary. This resolves the last hard blocker in `thermostat.jfn`
(`runScript -> Report`) while keeping the shorthand gate intact. It is a change
to the `handle` rule, not general guest polymorphism.

See
[`builtin-polymorphism-and-effects.md`](builtin-polymorphism-and-effects.md) for
the wider decisions: builtin-only polymorphism remains allowed, operator-defined
effect contracts are a separate planned layer, general guest generics stay out
of recenter, and specialized task-result indexing remains optional follow-up.

## Current state

The syntax, printer, and checker portions have landed. The checker now gives
the existing partial two-argument form a top result and gives the annotated
three-argument form its declared immediate result type. The shorthand
round-trips through `handle task -> Type with { ... }`.

Runtime enforcement has now landed in TypeScript as well:

- final data results are validated against the annotation;
- an unmatched effect in the annotated form raises `RuntimeContractError`
  instead of bubbling;
- generated `resume` closures retain the annotation;
- active module `$types` are available while resolving runtime contracts; and
- a function result is wrapped in a serializable callable contract that checks
  eventual arguments and returns.

The siblings (`perform`/`pure`/`bind`/`raise`) still return `TASK_FLOOR`.
`Task` remains opaque/nominal for this milestone.

## Design

- Keep the existing two-argument `handle(task, handlers)` as the partial form:
  unmatched effects bubble and the checker synthesizes top.
- Add a three-argument annotated form
  `handle(task, handlers, raw(resultSchema))`. In shorthand it is written
  `handle task -> ResultType with { ... }`. The checker treats the third
  argument as type syntax, not as an inferred guest value, and synthesizes that
  schema as the type of the immediate `handle` expression.
- The **runtime validates the produced value against that annotation at the
  boundary**. Handler-produced values are untrusted inputs from the contract's
  perspective, and a sandboxed embedding wants this validation anyway.
- The annotated form is **total**: if evaluation attempts to bubble an
  unmatched effect, it raises a runtime contract error instead of returning a
  residual task as the declared result. Recursive calls made by `resume` retain
  the annotation and the same totality rule.
- `Task` stays opaque/nominal; `perform`/`pure`/`bind`/`raise` keep their
  current `Task`-returning floors for this work. A specialized erased
  `Task<A>` checker index may be evaluated later, independently of general
  guest generics.
- **User-facing generics stay excluded**, preserving the shorthand gate.

Runtime schema validation was designed in the type-system plan but was not
previously wired into evaluator or host boundaries. This slice introduces the
shared concrete validator and callable-boundary path for `handle`; broader host
input/output adoption remains separate work.

The annotation is allowed to reference module `$types`. Runtime validation
therefore needs the active module definitions as well as the schema; treating a
`$ref` as top or requiring callers to inline named types would make the
contract unsound or unusable.

### Canonical and shorthand form

```jfn
handle task -> string with {
  "read": (resume) => resume("value")
}
```

lowers to:

```json
{
  "$call": "handle",
  "$args": [
    { "$var": "task" },
    { "read": { "$params": ["resume"], "$return": { "$call": "resume", "$args": ["value"] } } },
    { "$raw": { "type": "string" } }
  ]
}
```

The `$raw` wrapper is required because the schema is contract data, not a term
to evaluate. In particular, schemas containing `$ref` or `$fnType` must not be
classified as expression nodes. The wrapper is a canonical transport detail;
the shorthand parser and printer expose only the type expression.

### The thermostat target is a function contract

`thermostat.jfn` uses the standard state-handler encoding:

```jfn
(handle task with { ... })(initialState)
```

The immediate result of `handle` is therefore a function, not `Report`. Its
annotation must describe that value, for example:

```jfn
(handle task -> (ScriptState) -> Report with { ... })(initialState)
```

Consequently the runtime validator cannot stop at concrete data schemas.
`$fnType` validation must install or enforce a callable boundary contract so
the eventual arguments and return value are checked; merely recognizing a
closure or trusting an embedded `$sig` would not validate the handler-produced
function. This is part of the shared boundary-validation prerequisite, not a
reason to special-case `thermostat.jfn`.

## Work items

- **Checker — done**: accept arity two or three. Preserve the current top-returning
  floor for the partial two-argument form. For arity three, require a
  `raw(schema)` annotation in the tractable fragment, resolve its references,
  and return that schema (a code rule rather than a static `RuleFloor`).
  Files: `typescript/src/check/builtin-rules.ts`.
- **Runtime — done**: validate a final `handle` result against the declared type and
  raise on mismatch. Reject an unmatched effect in the annotated form at the
  point it would otherwise bubble, and preserve the contract in generated
  `resume` closures. Make active module `$types` available to the validator.
  Function schemas require a callable contract boundary, not a shape-only
  check. Implemented in `typescript/src/runtime-contract.ts`, with integration
  in `evaluate.ts`, `task.ts`, and `stdlib.ts`.
- **Shorthand — done**: parse/print the annotation form. Files:
  `typescript/src/shorthand/parser.ts`, `printer.ts`, and a shared type-schema
  printer paired with `type-parser.ts`.
- **Docs + spec — done for this slice**: `docs/language.md` (effects section),
  `plans/effects-implementation.md` (update), `spec/cases/` + `spec/parse-cases/`.
- **Spec totality — done in TypeScript**: cover a matching handler, `"return"` transformation,
  wildcard totality, an unmatched effect, and a value that violates the
  declared result schema. Pin that the old unannotated form still bubbles.
  Cover a named `$ref` annotation and a function-valued state-handler result.
- **Validate — done**: `thermostat.jfn` now annotates the immediate state
  function as `(ScriptState) -> Report`; `runScript -> Report` checks with zero
  errors and the `demo` entry evaluates through the runtime contract.

## Landing checklist

- `handle` result type comes from the declared annotation, not top.
- Runtime validates the `handle` result at the boundary and raises on
  mismatch.
- The annotated form is total and the unannotated form remains partial; no
  residual `Task` is statically presented as the declared result.
- Annotation form round-trips through the shorthand.
- `Task` stays opaque for this milestone; no general guest generics introduced.
- `thermostat.jfn` `runScript -> Report` no longer blocked.
