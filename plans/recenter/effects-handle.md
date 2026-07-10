# Effects — annotated `handle`, no user-facing generics

Overview for §6 of `plans/recenter-plan.md`. Goal: give `handle` a declared
result-type annotation the checker trusts statically and the runtime validates
at the boundary — instead of adding real `Task<A>` generics. This resolves the
last hard blocker in `thermostat.jfn` (`runScript -> Report`) while keeping the
shorthand gate intact. It's a change to the `handle` rule *floor*, not a
type-system feature.

## Current state

`handle` is an escape-hatch rule with an inert floor returning top:

```266:266:typescript/src/check/builtin-rules.ts
  handle: { arity: 2, returns: true },
```

Its siblings (`perform`/`pure`/`bind`/`raise`) return `TASK_FLOOR` and stay as
they are. `Task` stays opaque/nominal.

## Design

- `handle` **takes (or requires) a declared result-type annotation**; the
  checker trusts it statically as `handle`'s result type instead of returning
  top.
- The **runtime validates the produced value against that annotation at the
  boundary** — handler-produced and host-supplied values are exactly the
  untrusted inputs the runtime-boundary model was built for, and a sandboxed
  embedding wants this validation anyway.
- `Task` stays opaque/nominal; `perform`/`pure`/`bind`/`raise` keep their
  current `Task`-returning floors.
- **User-facing generics stay excluded**, preserving the shorthand gate.

## Open decision: how the annotation is supplied

Pick one and note it:

- an extra annotation argument / annotated form on the `handle` call, or
- a dedicated node shape carrying the result type.

Whichever is chosen must round-trip through the shorthand and stay inside the
tractable type fragment.

## Work items

- **Checker**: replace `handle`'s `returns: true` floor with logic that reads
  the declared result type and returns it (likely a code rule rather than a
  static `RuleFloor`, given the return depends on an argument). Files:
  `typescript/src/check/builtin-rules.ts`.
- **Runtime**: validate the `handle` result against the declared type at the
  boundary; raise on mismatch. Files: `typescript/src/evaluate.ts` and/or
  `typescript/src/task.ts`, reusing the existing runtime schema-validation used
  for host inputs.
- **Shorthand**: parse/print the annotation form. Files:
  `typescript/src/shorthand/parser.ts`, `printer.ts`, and `type-parser.ts` if
  the annotation is a type.
- **Docs + spec**: `docs/language.md` (effects section),
  `plans/effects-implementation.md` (update), `spec/cases/` + `spec/parse-cases/`.
- **Validate**: `thermostat.jfn` `runScript -> Report` checks clean.

## Landing checklist

- `handle` result type comes from the declared annotation, not top.
- Runtime validates the `handle` result at the boundary and raises on
  mismatch.
- Annotation form round-trips through the shorthand.
- `Task` stays opaque; no user-facing generics introduced.
- `thermostat.jfn` `runScript -> Report` no longer blocked.
