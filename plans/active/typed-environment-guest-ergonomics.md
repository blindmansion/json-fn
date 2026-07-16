# Typed-environment guest ergonomics

## Goal

Finish the guest-facing half of the typed-environment work. An operator should
declare effects and types once, and guest code should use that API with ordinary
call syntax and compositional `Task<A>` types. Correctly structured effect code
should not need raw effect-name strings, inlining, repeated expressions, or
checker-specific rewrites.

The serialized task representation may continue to contain effect-name strings.
They are stable runtime data needed for handling, persistence, and resume; they
do not need to be part of the source-level API.

This plan should be sequenced with
[remove-environment-compatibility.md](remove-environment-compatibility.md).
That cleanup is not incidental: making the environment the only checker/runtime
configuration removes branches and duplicate signatures that would otherwise
make each ergonomic feature more complicated.

## Problems exposed by the migrated examples

### 1. Effect contracts are injected, but effect calls are not

The environment tells the checker and runtime that `sensor.read` exists, but
the guest still writes:

```jfn
perform("sensor.read", [])
```

Direct host functions already have natural call syntax, but they execute during
evaluation. Effects must remain inert task constructors so they can be handled
in-language, serialized, admitted by capability policy, and suspended by a
durable driver. Replacing effects with direct functions would therefore be a
semantic regression.

The missing layer is a manifest-derived source API: a call such as
`sensor.read()` should construct the same inert
`{ "@task": "effect", name: "sensor.read", args: [] }` data as `perform`.

Open design points:

- how an effect callable is distinguished from a direct function when the two
  namespaces contain the same name;
- whether effect names are exposed as dotted callables, under a dedicated
  namespace/record, or through dedicated syntax;
- whether raw `perform` remains a low-level escape hatch or is unavailable to
  environment-constrained guest code; and
- whether handler clauses keep string keys or gain the same source-level naming
  surface.

### 2. Bare `Task` erases completion types at helper boundaries

The checker can derive `Task<Reading | null>` for a literal manifest-backed
effect and `Task<State>` through `bind`, but guest signatures can only write
bare `Task`. A helper such as:

```jfn
onReading: (st: State, reading: Reading) -> Task => ...
```

is therefore seen by callers as `Task<unknown>`. The migrated examples had to
inline `onReading` and `playTurn`; the same erasure prevented typed `dev()` and
`io()` wrappers from preserving effect results.

The environment entry currently avoids this only through an entry-specific
checker pass that substitutes the environment's completion type for recursive
calls. That does not compose for ordinary guest helpers.

Resolve this with one normal mechanism:

- support guest `Task<A>` annotations and erase the index at runtime; or
- retain an inferred completion type for function bindings whose public
  annotation is bare `Task`, including a sound rule for recursion.

Prefer explicit `Task<A>` unless inference can remain predictable and portable.
The compatibility-removal plan's injected entry signature should use this same
function-body path rather than preserving the entry-only exception.

### 3. `do` locals can lose narrowing and result precision

`do` lowers to `bind`, and a plain local binding introduces an immediately
invoked scope object. In the migrated dungeon, a value narrowed from
`string | null` to `string` became nullable again when referenced through a
nested `do` local. Earlier thermostat work also showed scope calls erasing the
scope's `$return` type.

Fix the lowered form rather than teaching authors workarounds:

- an invoked scope must synthesize its `$return` type;
- facts active where the scope is created must remain available to lazy locals;
- a local forced under a narrowed branch must use that branch's facts; and
- `do` and its explicit `bind` expansion must agree on result and diagnostic
  behavior.

Afterward, restore single-evaluation locals in dungeon instead of repeating
`step(st, cmd)`.

### 4. Portable fallback diagnostics can conflict with precise rules

A callable with a host-language type rule is first checked against its portable
fallback. For `bind`, the fallback contextually typed a continuation with
`Task<any>` before `core.bind` retyped it with the manifest completion type.
Diagnostics from the broad pass survived and rejected valid code.

The immediate migration fix reruns fallback diagnostics while omitting callbacks
owned by the precise rule. Consolidate this into an explicit rule-engine
contract:

- a rule declares which arguments it contextually owns;
- fallback validation still reports arity and non-owned argument errors;
- owned callbacks are diagnosed exactly once under the rule's context; and
- nested/lazy diagnostics do not depend on path-prefix filtering.

### 5. Handler clauses remain a dynamic coverage seam

The thermostat and dungeon modules now check with zero errors, but their
in-language test handlers still report coverage degradation because handler
clause lambdas have no declared signatures.

The configured effect manifest already supplies the effect argument types and
result type needed to type:

- each clause's effect arguments;
- the `resume` continuation argument and result;
- `return`; and
- the annotated handler result.

Contextually type those clauses from the manifest and the handled task instead
of requiring repetitive guest annotations.

### 6. CLI execution does not consistently consume the environment

`jfn check --environment` loads operator definitions, while `jfn eval` does not.
The thermostat's in-language demo consequently needs a lower-level API call to
resolve `Reading` in its runtime handler contract.

Under the compatibility-removal plan, make module execution environment-driven.
Keep a clear distinction between:

- running the environment's authoritative entry with boundary validation; and
- development evaluation of another named module function using the
  environment's definitions and callable surface without claiming it satisfies
  the production entry contract.

Do not retain an environment-free module path merely to preserve the old CLI.

## Clean-break simplifications

Implement [remove-environment-compatibility.md](remove-environment-compatibility.md)
before or with this work:

- one `runTask(module, environment, args, host, limits?)` path means generated
  effect callables and runtime contracts are installed once;
- one checker environment path means effect callables, definitions, and rules
  cannot silently disappear through legacy options;
- an injected entry signature removes duplicate guest annotations and the
  entry-specific reconciliation pass;
- normal contextual function-body checking can carry `Task<A>` for both the
  entry and ordinary helpers; and
- an environment-driven CLI does not need parallel legacy setup.

Do not add ergonomic features to both old and new paths.

## Delivery order

1. Remove compatibility paths and route entry checking through an injected
   signature.
2. Choose and implement the manifest-derived effect-call syntax and collision
   policy.
3. Add compositional helper completion types (`Task<A>` or an equally explicit
   alternative).
4. Fix scope-call result synthesis and narrowing through `do` locals.
5. Formalize fallback-versus-rule diagnostic ownership.
6. Contextually type effect handlers.
7. Make CLI checking and execution consistently environment-driven.
8. Rewrite thermostat and dungeon in the intended natural style and remove the
   workaround shapes from their regression tests.

Steps 2 and 3 should be designed together: generated effect calls are only
useful if their completion types survive helper boundaries.

## Acceptance examples

The intended thermostat shape should be possible without raw strings or
inlining:

```jfn
{
  actuate: (action: Action) -> Task<null> => match action.tag {
    "switch" -> effects.hvac.set(action.to),
    "alarm"  -> raise(action.fault),
    else     -> pure(null)
  },

  onReading: (st: State, reading: Reading) -> Task<State> => do {
    action: decide(st.config, st.mode, reading),
    _ <- effects.log(describe(action, reading)),
    _ <- actuate(action),
    pure(apply(st, action))
  },

  loop: (st: State, fuel: integer) -> Task<State> =>
    if fuel <= 0 then pure(st)
    else do {
      reading <- effects.sensor.read(),
      if isNull(reading) then pure(st)
      else do {
        next <- onReading(st, reading),
        loop(next, fuel - 1)
      }
    }
}
```

The illustrative `effects` qualification may change with the collision
decision, but the compositional shape should not.

## Completion criteria

- Guest code calls declared effects without spelling raw effect-name strings.
- Source-level effect calls still construct inert, serializable task data.
- Helper functions preserve concrete task completion types.
- `do` locals preserve narrowing and synthesize the same result as explicit
  `bind`.
- Precise callable rules do not inherit stale callback diagnostics from their
  portable fallbacks.
- Manifest-backed handlers have complete type coverage where their contracts
  are tractable.
- Checker, runtime, and CLI consume the environment through one configuration
  path.
- Thermostat and dungeon use natural helpers with no checker-specific inlining
  or repeated expressions.
- TypeScript checks and tests pass after legacy-path tests and workaround
  fixtures are removed.

## Non-goals

- Changing the serialized task node format.
- Making direct host functions durable or handler-interceptable.
- Implementing the B6 durable orchestration driver.
- Preserving compatibility with pre-environment host/checker APIs.
