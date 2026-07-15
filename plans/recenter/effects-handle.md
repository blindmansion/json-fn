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

`handle` is an escape-hatch rule with an inert floor returning top:

```266:266:typescript/src/check/builtin-rules.ts
  handle: { arity: 2, returns: true },
```

Its siblings (`perform`/`pure`/`bind`/`raise`) return `TASK_FLOOR` and stay as
they are for this milestone. `Task` stays opaque/nominal here.

One detail the original proposal missed: `handle` preserves bubbling. When no
clause matches an effect, runtime `handle` returns a residual `Task`, not the
declared final value. A precise result annotation therefore needs a totality
rule; validation cannot simply treat every current return path as `Report`.

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

Runtime schema validation is designed in the type-system plan but is not
generally wired into evaluator or host boundaries yet. This work must introduce
or share the concrete validator path; it must not assume host-input validation
already exists.

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

- **Checker**: accept arity two or three. Preserve the current top-returning
  floor for the partial two-argument form. For arity three, require a
  `raw(schema)` annotation in the tractable fragment, resolve its references,
  and return that schema (a code rule rather than a static `RuleFloor`).
  Files: `typescript/src/check/builtin-rules.ts`.
- **Runtime**: validate a final `handle` result against the declared type and
  raise on mismatch. Reject an unmatched effect in the annotated form at the
  point it would otherwise bubble, and preserve the contract in generated
  `resume` closures. Make active module `$types` available to the validator.
  Function schemas require a callable contract boundary, not a shape-only
  check. Files: `typescript/src/evaluate.ts` and/or `typescript/src/task.ts`,
  using a shared concrete schema validator.
- **Shorthand**: parse/print the annotation form. Files:
  `typescript/src/shorthand/parser.ts`, `printer.ts`, and a shared type-schema
  printer paired with `type-parser.ts`.
- **Docs + spec**: `docs/language.md` (effects section),
  `plans/effects-implementation.md` (update), `spec/cases/` + `spec/parse-cases/`.
- **Spec totality**: cover a matching handler, `"return"` transformation,
  wildcard totality, an unmatched effect, and a value that violates the
  declared result schema. Pin that the old unannotated form still bubbles.
  Cover a named `$ref` annotation and a function-valued state-handler result.
- **Validate**: `thermostat.jfn` `runScript -> Report` checks clean.

## Landing checklist

- `handle` result type comes from the declared annotation, not top.
- Runtime validates the `handle` result at the boundary and raises on
  mismatch.
- The annotated form is total and the unannotated form remains partial; no
  residual `Task` is statically presented as the declared result.
- Annotation form round-trips through the shorthand.
- `Task` stays opaque for this milestone; no general guest generics introduced.
- `thermostat.jfn` `runScript -> Report` no longer blocked.
