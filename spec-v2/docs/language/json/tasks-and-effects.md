# Tasks and effects

Expression evaluation is pure. A task is inert data that describes an effectful
computation. Building a task does not run its effects. A task runs only when
interpreted by `handle` or executed at a host boundary.

Tasks use three constructors, `perform`, `pure`, and `bind`. `raise` is a
convenience constructor, and `handle` interprets tasks in-language.

## Task representation

A task is a tagged plain object. Its `@task` key is not an expression-form key,
so task values remain ordinary inert data. There are three node kinds:

```json
{ "@task": "effect", "name": "http.get", "args": ["https://example.com"] }
{ "@task": "pure", "value": 42 }
{ "@task": "bind", "task": { "@task": "pure", "value": 1 }, "then": { "$params": ["x"], "$return": { "$call": "pure", "$args": [{ "$var": "x" }] } } }
```

- **`effect`** requests one effect by `name` with positional `args`.
  `raise(err)` creates the distinguished effect named `raise`.
- **`pure`** is a completed task whose result is `value`.
- **`bind`** sequences: run `task`, then apply the continuation `then` to obtain the next task. A one-parameter continuation receives the completed value; a zero-parameter continuation discards it (the shape emitted by a non-final bare expression in `do` notation).

Constructing a task is pure: a task built in a
[`$let` binding](expressions.md#let-binding--let-in) is inert data, and one
never sequenced into the handled task performs nothing.

## Constructors

These are standard-library functions; see
[Standard library](standard-library.md#tasks-and-effects).

- `perform(name, args)` — build an `effect` task. `name` must be a string, `args` an array.
- `pure(value)` — build a completed task carrying `value`.
- `bind(task, k)` — sequence; `k` must be a function name or body.
- `raise(err)` — convenience for `perform("raise", [err])`.

An environment contract gives each effect positional argument schemas and a
result schema. A literal `perform` checks its arguments, and the result type
flows through `bind`. Signatures may use `Task<A>`; bare `Task` means
`Task<any>`. `Task` is the only built-in type constructor and cannot be
redefined; other user-facing generics are unsupported. Its type argument is
static and is not stored in task records. A dynamic effect name cannot be
resolved statically and produces degraded type coverage.

A contract-linked module receives a reserved `effects` binding. Dot-separated
effect names become nested callable
paths:

```jfn
effects.http.get(url)
effects.log("starting")
```

Each leaf is a typed task constructor equivalent to
`perform("http.get", [url])`; calling it remains pure and does not invoke the
host capability. A linked module cannot declare a top-level `effects` binding.
An effect name cannot be a namespace prefix of another name, so `sensor` and
`sensor.read` cannot coexist. Direct `perform` remains available.

Malformed tasks fail with guest-visible evaluation errors when run, rather than
host-language exceptions.

## The suspended form

Running a task normalizes its `bind` chain to one of two shapes:

```json
{ "done": 42 }
{ "pending": { "name": "http.get", "args": ["https://example.com"], "resume": { "$params": ["__v"], "$return": "..." } } }
```

`resume` is a self-contained closure from the effect result to the remaining
task. A pending value is serializable and its continuation may be applied more
than once.

## `handle` — interpreting effects in-language

`handle(task, clauses)` runs a task and dispatches effects to clauses. This
two-argument form is partial: unmatched effects bubble.

`handle(task, clauses, { "$raw": resultSchema })` is the total annotated form.
Its immediate result is checked against `resultSchema`, and its static type is
that schema. An unmatched effect raises `RuntimeContractError`. Every generated
`resume` retains the annotation. Named types resolve through the module's
`$types`.

Clause lookup is by effect name:

- A **named clause** `"http.get": (url, resume) => …` receives the effect's args spread positionally, then `resume` last.
- The reserved **`"*"` wildcard** clause `"*": (eff, resume) => …` catches any otherwise-unmatched effect and receives `eff = { name, args }` plus `resume`.
- The reserved **`"return"` clause** `"return": (v) => …` runs when the task completes normally with value `v`; its result is final and is **not** re-interpreted by this handler. Without a `"return"` clause, `handle` returns the completion value directly.

For an annotated total handler of `Task<A>` with result annotation `R`, the
checker contextually types each contract-declared clause as
`(...effectArgs, resume: (effectResult) -> R) -> R` and types `return` as
`(A) -> R`. Wildcard and built-in `raise` payloads remain broad because
`Task<A>` does not track an effect row or raised-payload type. The unannotated
partial form has no declared `R`, so it retains its imprecise static result.

Calling `resume` twice runs the remainder twice.

In the partial form, an unmatched effect is re-performed with a continuation
that re-enters the same handler. It bubbles to an enclosing handler or the host.
The annotated form rejects an unmatched effect.

For a function result annotation such as `(State) -> Report`, the function
value is checked when produced; its arguments and results are checked when it is
called.

```jfn
(handle task returns (ScriptState) -> Report with {
  // clauses return functions awaiting ScriptState
})(initialState)
```

```jfn
handle greet(mockIo()) with {
  "io.readLine": (resume) => resume("world"),
  "io.print":    (msg, resume) => resume(null)
}
```

Dispatching a handler clause is an arm-selection event, and the clauses use
the normal call path, so invocation charges and call-depth limits apply.

## Host execution

The host is the outermost handler. It returns a completed value, dispatches a
pending effect to its declared capability, and resumes the task with the
capability result. An unhandled `raise` or an effect without a capability
fails.

The [environment contract](../../deployment/environment-contract.md) declares
effect and entry schemas. The
[deployment profile](../../deployment/deployment-profile.md) selects live or
durable execution, available effects, and portable limits. The host validates
entry arguments, direct results, effect arguments, effect results, and task
completion values at those boundaries.

A call may supply any argument count from the entry's required count through
its required-plus-optional count. Supplied optional arguments are validated.
A direct entry returns an immediate value. A task entry returns a task whose
eventual completion value is validated. Task entries may suspend across process
boundaries under a durable profile. Durable delivery, recovery, and
at-least-once execution are defined in
[Durable task hosting](../../runtime/durable-host.md).

A normalized `pending` record is host state, not a task node. Durable hosts
persist it through the workflow-record format. Because external effects may run
more than once after recovery, effect handlers should use idempotency keys when
required.

