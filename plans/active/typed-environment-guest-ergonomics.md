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

The compatibility-removal prerequisite is complete. Making the environment the
only checker/runtime configuration removed branches and duplicate signatures
that would otherwise make each ergonomic feature more complicated.

## Problems exposed by the migrated examples

### 1. Effect contracts are injected, but effect calls are not — ✅ resolved

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

The implemented layer is a manifest-derived source API: a call such as
`effects.sensor.read()` should construct the same inert
`{ "@task": "effect", name: "sensor.read", args: [] }` data as `perform`.

Resolved for the source-call surface:

- the environment injects a reserved `effects` record whose nested paths are
  derived from dot-separated manifest names;
- direct functions and effects may share a name because `log()` and
  `effects.log()` are unambiguous;
- namespace-prefix conflicts such as `sensor` plus `sensor.read` are invalid;
- raw `perform` remains a low-level escape hatch; and
- handler clauses keep string keys for now. Their typing remains step 6.

### 2. Bare `Task` erases completion types at helper boundaries — ✅ resolved

The checker can derive `Task<Reading | null>` for a literal manifest-backed
effect and `Task<State>` through `bind`, but guest signatures can only write
bare `Task`. A helper such as:

```jfn
onReading: (st: State, reading: Reading) -> Task => ...
```

is therefore seen by callers as `Task<unknown>`. The migrated examples had to
inline `onReading` and `playTurn`; the same erasure prevented typed `dev()` and
`io()` wrappers from preserving effect results.

Resolved with explicit guest `Task<A>` annotations, lowered to the checker's
existing erased `{ "$taskType": A }` node. Bare `Task` means `Task<any>` and
deliberately erases completion precision; it does not trigger public return-type
inference. `Task` is the sole built-in type constructor and cannot be redefined,
so this does not introduce general user-facing generics.

Explicit signatures compose with the checker's eager function bindings, making
recursive helpers precise without recursive return inference. The
environment-injected entry signature uses the same checker node and normal
function-body path. Runtime task records and serialization are unchanged.

### 3. `do` locals can lose narrowing and result precision — ✅ resolved

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

Resolved by synthesizing unannotated invoked scopes from their `$return` and
making lazy-local resolution merge the facts active when the scope was created
with any additional facts active where the local is forced. The fact-sensitive
cache is keyed from that merged, free-variable-filtered set. Explicit `bind`
continuations and shorthand `do` therefore use the same checker paths, and the
dungeon now binds `step(st, cmd)` once.

### 4. Portable fallback diagnostics can conflict with precise rules — ✅ resolved

A callable with a host-language type rule is first checked against its portable
fallback. For `bind`, the fallback contextually typed a continuation with
`Task<any>` before `core.bind` retyped it with the manifest completion type.
Diagnostics from the broad pass survived and rejected valid code.

Resolved with declarative `contextualArguments` metadata on host-language rule
definitions. The engine computes the portable fallback first, runs the precise
rule, then reruns fallback validation while omitting declared unannotated inline
callbacks. Arity and non-owned argument errors remain fallback-owned, while the
engine enforces that each applicable owned callback is contextually typed
exactly once by the rule.

Referenced and explicitly annotated callbacks remain concrete values checked by
the fallback. Unavailable rules retain the complete fallback behavior. The
rerun deliberately avoids path-prefix filtering because lazy-local diagnostics
may use binding-relative paths.

### 5. Handler clauses remain a dynamic coverage seam — ✅ resolved

The thermostat and dungeon modules now check with zero errors, but their
in-language test handlers still report coverage degradation because handler
clause lambdas have no declared signatures.

The configured effect manifest already supplies the effect argument types and
result type needed to type:

- each clause's effect arguments;
- the `resume` continuation argument and result;
- `return`; and
- the annotated handler result.

Resolved for annotated total handlers. The `core.handle` rule derives the
handled completion type from `Task<A>`, takes the immediate result `R` from the
annotation, and checks literal clause records under manifest-derived signatures:

- a manifest clause is `(...effectArgs, resume: (effectResult) -> R) -> R`;
- `return` is `(A) -> R`;
- `*` receives the runtime `{ name, args }` envelope and a broad `(any) -> R`
  resume; and
- the built-in `raise` clause receives a broad payload and an unreachable
  resume. Its result remains broad because `Task<A>` does not carry a raised
  payload type.

Callable-rule ownership now covers an entire contextually checked argument, not
only a top-level lambda, so fallback synthesis of the clause record cannot leave
stale unannotated-function diagnostics. Non-literal records and clause names
without configured contracts report coverage degradation. Partial handlers
remain intentionally imprecise because they have no declared `R`.

### 6. CLI execution does not consistently consume the environment — ✅ resolved

Compatibility removal had already made `jfn eval --environment` load the
environment and run its authoritative entry through `runTask`, but it did not
provide the distinct development path needed by in-language demos. The CLI
could neither select `demo` nor install the environment definitions and
generated `effects` namespace without also entering production capability
admission.

Resolved with two explicit environment-driven modes:

- `jfn eval --environment <path>` runs the authoritative entry through
  `runTask`, including boundary validation and host capability admission; and
- adding `--function <name>` invokes that module function through `callProgram`
  with the environment definition pool and manifest-derived `effects` value,
  without claiming the function satisfies the production entry contract.

The development mode requires an environment and does not invent
implementations for direct host functions or effects that bubble out of
in-language handlers. Thermostat and dungeon demos now execute directly through
this path.

## Clean-break simplifications

The completed compatibility-removal slice established:

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

1. ✅ Remove compatibility paths and route entry checking through an injected
   signature.
2. ✅ Choose and implement the manifest-derived effect-call syntax and collision
   policy.
3. ✅ Add compositional helper completion types (`Task<A>`).
4. ✅ Fix scope-call result synthesis and narrowing through `do` locals.
5. ✅ Formalize fallback-versus-rule diagnostic ownership.
6. ✅ Contextually type effect handlers.
7. ✅ Make CLI checking and execution consistently environment-driven.
8. ✅ Rewrite thermostat and dungeon in the intended natural style and remove the
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

The `effects` qualification is the manifest-derived guest API; the
compositional shape remains the target for the following steps.

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
