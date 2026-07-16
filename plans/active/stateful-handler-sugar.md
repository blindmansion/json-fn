# Stateful handler shorthand

Status: proposed.

## Summary

Stateful effect handlers are already expressible in json-fn by making every
handler clause return a function from state to result:

```jfn
(handle task -> (State) -> Result with {
  effect: (arg, resume) => (state) =>
    resume(value)(nextState),
  return: (value) => (state) =>
    finish(value, state)
})(initialState)
```

This is a standard pure state-passing transformation, but it exposes the
transformation's machinery at every use site. Stateful handler shorthand should
make the state and its transitions direct while lowering entirely to the
existing functions, calls, and `handle` builtin:

```jfn
handle task -> Result
  with state (state: State = initialState) {
  effect: (arg, resume) =>
    resume(value, nextState),
  return: (value) =>
    finish(value, state)
}
```

The feature is shorthand only. It adds no canonical JSON node, evaluator
primitive, mutable state, or persisted runtime state.

## Motivation

The typed examples use stateful handlers to run effectful programs against
deterministic in-language hosts:

- a queue supplies scripted input or sensor readings;
- output effects append to a transcript;
- actuator effects record commands;
- `return` packages the final value and transcript;
- `raise` turns a guest fault into a test report.

The current encoding is semantically useful: it proves that ordinary json-fn
functions are enough to implement state handlers and keeps continuation state
plain JSON. Its surface form is nevertheless difficult to read and easy to
misunderstand:

- the handler's annotated result is `(State) -> Result`, not the result the
  caller ultimately wants;
- every clause has an extra `(state) =>` function layer;
- continuing is written `resume(value)(nextState)`;
- the entire handler must be called with its initial state;
- record reconstruction obscures the effect response and state transition.

This friction will recur in agent/API orchestration tooling. Production
workflows generally let effects reach the durable host, but deterministic
tests, dry-runs, replay fixtures, policy sandboxes, and simulated approval
flows need in-language interpreters that both answer effects and accumulate
state.

## Goals

- Make stateful handlers read as effect responses plus explicit state
  transitions.
- Preserve pure, immutable, multi-shot continuation semantics.
- Lower to the existing canonical JSON representation.
- Keep all handler state inside serializable JSON closures.
- Reuse the existing `handle` runtime and checker behavior.
- Support typed final results without exposing `(State) -> Result` to authors.
- Provide a canonical printer form for the lowered shape if recognition can be
  made strict and deterministic.

## Non-goals

- Mutable handler-local variables.
- Transactional commits or automatic rollback.
- State persisted separately from a suspended continuation.
- Changing `resume` globally for ordinary handlers.
- Defining durable-driver storage or idempotency behavior.
- Automatically converting arbitrary existing state-transformer code into the
  new surface form.
- Solving stateful partial handlers that allow other effects to bubble.

## Proposed surface form

The proposed form extends an annotated handler with a named, typed state
initializer:

```jfn
handle <task> -> <result-type>
  with state (<state-name>: <state-type> = <initial-state>) {
  <clauses>
}
```

Within each clause:

- `<state-name>` is bound to that clause's current state.
- A named clause keeps the ordinary effect arguments followed by `resume`.
- `resume(effectResult, nextState)` continues with an explicitly selected
  state.
- `return` receives the task's completion value and may read the final state.
- `raise` and wildcard clauses follow the same state-binding rule.

Example:

```jfn
handle task -> Report
  with state (s: ScriptState = { pending: readings, out: [] }) {
  "sensor.read": (resume) =>
    resume(
      head(s.pending),
      { pending: tail(s.pending), out: s.out }
    ),

  "log": (message, resume) =>
    resume(null, {
      pending: s.pending,
      out: concat(s.out, [message])
    }),

  raise: (fault, resume) =>
    { ending: fault.tag, out: s.out },

  return: (value) =>
    { ending: value, out: s.out }
}
```

The state argument to `resume` is required in the initial design. A possible
later convenience is for `resume(value)` to mean `resume(value, s)`, but
requiring the argument initially keeps state flow visible and avoids introducing
an unnecessary default before usage demonstrates its value.

## Lowering

Stateful handler shorthand lowers before evaluation and checking. Given:

```jfn
handle task -> Result
  with state (s: State = initial) {
  effect: (arg, resume) =>
    resume(answer, next),
  return: (value) =>
    finish(value, s)
}
```

the parser emits the same canonical structure as:

```jfn
(handle task -> (State) -> Result with {
  effect: (arg, resume) => (s) =>
    resume(answer)(next),
  return: (value) => (s) =>
    finish(value, s)
})(initial)
```

At the JSON level this remains:

1. a three-argument `handle(task, clauses, raw(functionResultSchema))` call;
2. clause functions whose results are functions awaiting state;
3. nested calls for `resume(answer)(next)`;
4. an outer call applying the produced state transformer to `initial`.

No stateful-handler marker survives lowering.

The lowering must be hygienic. The explicit state name is introduced as the
parameter of each generated state function, and generated intermediate names,
if any, must not collide with guest bindings.

## Semantics

### Explicit immutable state

State is an ordinary JSON value. Each clause observes one state and explicitly
chooses the state supplied to each resumption. There is no mutation before or
after `resume`.

```jfn
resume(value, nextState)
```

means exactly:

```jfn
resume(value)(nextState)
```

after lowering.

### Multi-shot resumptions

`resume` remains multi-shot. Calling it more than once runs independent copies
of the remainder of the handled task. Explicit state makes the branch behavior
unambiguous:

```jfn
concat(
  resume(leftValue, leftState),
  resume(rightValue, rightState)
)
```

Neither branch observes changes made by the other. An implicit mutable "current
state" would make branch order and sharing ambiguous and is therefore excluded.

### Return and early termination

The `return` clause sees the state that reaches normal task completion. A clause
may terminate handling by returning a final result without calling `resume`;
its current state remains available while constructing that result. This is how
scripted handlers turn `raise` into fault reports.

### Runtime contracts

The author-facing annotation is the final `Result`. Lowering changes the
immediate `handle` annotation to `(State) -> Result`, so the existing callable
runtime contract validates:

- the state-transformer function when produced;
- the initial and resumed states when supplied;
- the final result returned by the transformer.

The initializer must be assignable to `State`.

## Typing

Typing should be derived from the lowered form rather than adding a new checker
primitive.

For a handled `Task<A>`, state type `S`, and final result `R`, lowering gives the
ordinary handler result `(S) -> R`. Existing contextual handler typing then
sees:

```text
resume: (EffectResult) -> (S) -> R
return: (A) -> (S) -> R
```

The shorthand parser rewrites an authored:

```text
resume(effectResult, nextState)
```

to application of the contextually typed continuation followed by application
to `nextState`. Clause bodies are wrapped in `(state: S) => ...`.

Diagnostics should use source spans from the authored state declaration,
initializer, and two `resume` arguments where possible rather than exposing
paths through generated functions.

## Durability

The durable driver persists a task's self-contained JSON continuation. Because
stateful handler shorthand lowers to ordinary state-passing closures, state
captured across a suspension remains part of that continuation. The driver does
not need another state serializer or storage channel.

This layering should remain invariant:

```text
stateful handler shorthand
  -> pure state-transforming closures
  -> self-contained JSON continuations
  -> durable host persistence
```

State advancement occurs only by resuming the persisted continuation. The sugar
must not independently commit state around a host effect; doing so would create
transactional and at-least-once recovery questions outside the current task
model.

## Partial handlers and bubbling

The existing state-transformer encoding naturally describes a total
in-language interpreter. It does not cleanly compose with partial handling:

```jfn
(handle task with statefulClauses)(initial)
```

If an unmatched effect bubbles, the partial `handle` produces a residual
`Task`, not the state-transformer function expected by the outer application.
The same mismatch can occur after a handled clause resumes into a later
unmatched effect.

Consequently, the initial stateful syntax should require the annotated total
form and should reject unmatched effects exactly as the lowered annotated
handler does.

This is sufficient for:

- deterministic mocks;
- complete replay environments;
- dry-run interpreters;
- policy sandboxes that answer or reject every operation;
- scripted demos and conformance tests.

It is not sufficient for stateful production middleware that handles local
effects while allowing durable effects to bubble to the host. Supporting that
would require a separate design, potentially a state transformer whose result
remains a task, and must not be smuggled into this parser-only feature.

## Representative use cases

### Agent orchestration mock

A scripted host returns synthetic handles and queued agent results while
recording spawn/join events:

```jfn
handle workflow -> MockRun
  with state (s: Harness = { results, events: [] }) {
  "agent.spawn": (spec, resume) =>
    resume(
      { id: `mock-${str(length(s.events))}` },
      {
        results: s.results,
        events: concat(s.events, [`spawn ${spec.role}`])
      }
    ),

  "agent.await": (handle, resume) =>
    resume(
      head(s.results)!,
      {
        results: tail(s.results),
        events: concat(s.events, [`await ${handle.id}`])
      }
    ),

  return: (report) =>
    { report, events: s.events }
}
```

### SQL dry-run

A sandbox supplies canned rows and records every statement without granting
database access:

```jfn
handle migration -> SqlReport
  with state (s: SqlState = { rows, statements: [] }) {
  "db.query": (sql, resume) =>
    resume(head(s.rows)!, {
      rows: tail(s.rows),
      statements: concat(s.statements, [sql])
    }),

  "db.execute": (sql, resume) =>
    resume(0, {
      rows: s.rows,
      statements: concat(s.statements, [sql])
    }),

  return: (value) =>
    { statements: s.statements }
}
```

### API fixture replay

A deterministic API host returns fixtures while retaining an ordered request
log:

```jfn
handle workflow -> ReplayReport
  with state (s: ReplayState = { fixtures, requests: [] }) {
  "http.request": (request, resume) =>
    resume(head(s.fixtures)!, {
      fixtures: tail(s.fixtures),
      requests: concat(s.requests, [request])
    }),

  return: (result) =>
    { result, requests: s.requests }
}
```

### Approval and deployment simulation

A sandbox consumes scripted approvals and records planned mutations:

```jfn
handle deployment -> Simulation
  with state (s: SimState = { approvals, audit: [] }) {
  "approval.request": (summary, resume) =>
    resume(head(s.approvals)!, {
      approvals: tail(s.approvals),
      audit: concat(s.audit, [`approval: ${summary}`])
    }),

  "deploy.apply": (plan, resume) =>
    resume(fakeDeployment(plan), {
      approvals: s.approvals,
      audit: concat(s.audit, [`deploy: ${plan.id}`])
    }),

  raise: (fault, resume) =>
    { ending: fault.tag, audit: s.audit },

  return: (result) =>
    { ending: result.id, audit: s.audit }
}
```

Other likely applications include infrastructure-plan inspection, payment and
refund simulation, ETL checkpoint fixtures, incident-response runbooks,
repository migration agents, capability-attempt auditing, notification
campaign dry-runs, cached research-agent responses, and request/token budget
enforcement.

## Shorthand printer and normal form

The shorthand specification currently treats `do` and `handle` as parser sugar
with canonical printer recognition. Stateful handlers should ideally follow the
same model.

Recognition must be strict. The printer may render stateful syntax only when it
can prove the complete lowered shape:

- an outer single-argument call supplies the initial state;
- the callee is an annotated `handle`;
- the annotation is a one-argument function type `(S) -> R`;
- every handler clause has the generated outer parameters expected for that
  clause and returns a one-argument function over the same state binding;
- resumptions use the nested `resume(value)(nextState)` shape;
- the return clause has the corresponding state-function layer.

If recognition is ambiguous, the printer must emit the ordinary expanded
handler and calls. The initial implementation may choose parser-only
normalization to the expanded form, but that makes the new spelling a
noncanonical input alias and should be an explicit temporary limitation.

## Implementation outline

1. Specify the exact grammar and resolve line-breaking/precedence around
   `with state`.
2. Add parser support that constructs the existing lowered JSON shape.
3. Preserve source locations through generated clause wrappers and resume calls.
4. Add parse cases for named, wildcard, `raise`, and `return` clauses; nested
   handlers; multi-shot resume; and binding hygiene.
5. Verify existing checker rules type the lowered form completely; add only
   parser-facing diagnostic translation if required.
6. Add evaluator cases proving equivalence with manually expanded state
   handlers.
7. Add printer recognition and parse/print normalization cases, or document the
   initial expanded-print limitation.
8. Migrate one typed example first, then compare readability before migrating
   the others.

## Open decisions

- Exact grammar: `with state (s: S = initial)` versus another ordering that
  reads cleanly beside `-> Result`.
- Whether `resume(value)` may later default to the unchanged current state.
- Whether the first release requires canonical printer recognition.
- Whether stateful wildcard and `raise` clauses should be required for totality,
  inferred from the environment, or left to the existing runtime/checker rules.
- Whether a separate future feature should support stateful partial handlers
  that preserve state while effects bubble to the durable host.
