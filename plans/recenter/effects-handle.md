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

- `handle` **takes (or requires) a declared result-type annotation**; the
  checker trusts it statically as `handle`'s result type instead of returning
  top.
- The **runtime validates the produced value against that annotation at the
  boundary**. Handler-produced values are untrusted inputs from the contract's
  perspective, and a sandboxed embedding wants this validation anyway.
- The annotation is meaningful only with an explicit **totality contract**.
  The smallest sound interpretation is that an annotated `handle` is total:
  if evaluation attempts to bubble an unmatched effect, the annotation
  contract fails rather than returning a residual task as `Report`.
- `Task` stays opaque/nominal; `perform`/`pure`/`bind`/`raise` keep their
  current `Task`-returning floors for this work. A specialized erased
  `Task<A>` checker index may be evaluated later, independently of general
  guest generics.
- **User-facing generics stay excluded**, preserving the shorthand gate.

Runtime schema validation is designed in the type-system plan but is not
generally wired into evaluator or host boundaries yet. This work must introduce
or share the concrete validator path; it must not assume host-input validation
already exists.

## Open decisions

### Totality and bubbling

Recommended for recenter: make an annotated `handle` total. A bubbled effect is
a runtime contract failure, and the checker may return the declared result
schema.

Alternatives, if preserving bubbling on the annotated form is required:

- type the expression as `DeclaredResult | Task`, which does not unblock a
  function returning only `DeclaredResult`; or
- defer precision until effect-set tracking can prove all effects discharged,
  which is outside recenter.

Choose and record this before implementation. The unannotated two-argument
`handle` may continue its current partial/bubbling behavior and synthesize top.

### Annotation form

Pick one and note it:

- an extra annotation argument / annotated form on the `handle` call, or
- a dedicated node shape carrying the result type.

Whichever is chosen must round-trip through the shorthand and stay inside the
tractable type fragment.

## Work items

- **Checker**: replace `handle`'s `returns: true` floor with logic that reads
  the declared result type and returns it (likely a code rule rather than a
  static `RuleFloor`, given the return depends on an annotation). Preserve a
  distinct rule for an unannotated, partial `handle` if that form remains.
  Files: `typescript/src/check/builtin-rules.ts`.
- **Runtime**: validate a final `handle` result against the declared type and
  raise on mismatch. If the annotated form is total, reject an unmatched effect
  at the point it would otherwise bubble. Files: `typescript/src/evaluate.ts`
  and/or `typescript/src/task.ts`, using a shared concrete schema validator.
- **Shorthand**: parse/print the annotation form. Files:
  `typescript/src/shorthand/parser.ts`, `printer.ts`, and `type-parser.ts` if
  the annotation is a type.
- **Docs + spec**: `docs/language.md` (effects section),
  `plans/effects-implementation.md` (update), `spec/cases/` + `spec/parse-cases/`.
- **Spec totality**: cover a matching handler, `"return"` transformation,
  wildcard totality, an unmatched effect, and a value that violates the
  declared result schema. Pin whether the old unannotated form still bubbles.
- **Validate**: `thermostat.jfn` `runScript -> Report` checks clean.

## Landing checklist

- `handle` result type comes from the declared annotation, not top.
- Runtime validates the `handle` result at the boundary and raises on
  mismatch.
- Annotated-handle bubbling semantics are explicit and tested; no residual
  `Task` is statically presented as the declared result.
- Annotation form round-trips through the shorthand.
- `Task` stays opaque for this milestone; no general guest generics introduced.
- `thermostat.jfn` `runScript -> Report` no longer blocked.
