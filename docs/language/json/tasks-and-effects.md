# Tasks & Effects

json-fn is pure: evaluating an expression never performs I/O or any observable side effect. **Effects** are represented as _data_ — inert values called **tasks** that _describe_ an effectful computation without running it. Running a task is a separate step, performed either in-language by the `handle` builtin (which interprets each effect) or at the host boundary by a trampoline (`runTask`) that answers effects with real I/O.

The kernel is deliberately small: three task **constructors** (`perform`, `pure`, `bind`), one `raise` convenience, and one `handle` builtin. Everything richer — retries, error recovery, threaded state, dry-runs, capability attenuation — is ordinary json-fn library code, because [escaping-closure capture](closures.md#escaping-closures-carry-the-local-functions-they-call) makes every suspended continuation a self-contained JSON value.

## Task representation

A task is a tagged plain object. The tag key is `@task` — deliberately **not** a `$`-key, so a task classifies as an ordinary object and is never re-interpreted as an expression form. Tasks are **inert**: once built they are returned, stored, and passed around verbatim, never re-evaluated. There are three node kinds:

```json
{ "@task": "effect", "name": "http.get", "args": ["https://example.com"] }
{ "@task": "pure", "value": 42 }
{ "@task": "bind", "task": { "@task": "pure", "value": 1 }, "then": { "$params": ["x"], "$return": { "$call": "pure", "$args": [{ "$var": "x" }] } } }
```

- **`effect`** requests one effect by `name`, carrying its `args`. `raise(err)` is the distinguished effect named `raise`.
- **`pure`** is a completed task whose result is `value`.
- **`bind`** sequences: run `task`, then apply the continuation `then` to obtain the next task. A one-parameter continuation receives the completed value; a zero-parameter continuation discards it (the shape emitted by a non-final bare expression in `do` notation).

Because tasks are inert data, laziness composes with them cleanly: a task held
in an [unreferenced `$let` binding](expressions.md#let-binding--let-in) is never built, and
building a task never performs its effect. Nothing happens until something
_runs_ the task.

## Constructors

These are standard-library functions (see [Standard Library → Tasks & Effects](standard-library.md#tasks--effects)):

- `perform(name, args)` — build an `effect` task. `name` must be a string, `args` an array.
- `pure(value)` — build a completed task carrying `value`.
- `bind(task, k)` — sequence; `k` must be a function (registry name or body).
- `raise(err)` — convenience for `perform("raise", [err])`.

When the checker is configured with an effect manifest, each literal effect
name has positional argument schemas and a result schema. `perform` checks those
arguments, and the result type flows through `bind` (and therefore `do`
notation). Guest signatures may preserve that index explicitly with `Task<A>`;
bare `Task` means `Task<any>`. `Task` is the one built-in type constructor and
cannot be redefined; general user-facing generics remain unsupported. The index
is checker-only, and task records contain no runtime type metadata. A dynamic
effect name cannot be resolved statically and is reported as degraded type
coverage.

A contract-linked module also receives a reserved `effects` binding
derived from that manifest. Dot-separated effect names become nested callable
paths:

```jfn
effects.http.get(url)
effects.log("starting")
```

Each leaf is a typed task constructor equivalent to a literal
`perform("http.get", [url])`; calling it remains pure and does not invoke the
host capability. Qualification distinguishes effects from direct functions, so
`tap(...)` and `effects.log(...)` may coexist with different semantics. A module
checked or run with a contract may not declare its own top-level `effects`
binding. Manifest names may not be namespace prefixes of other names (for
example, `sensor` and `sensor.read` cannot both be declared). Direct `perform`
remains available as a low-level constructor.

Malformed tasks (e.g. a `bind` whose `then` is not a function, or an `effect` with a non-string `name`) are rejected as ordinary **guest-visible evaluation errors** when the task is run — never as host-language exceptions.

## The suspended form

Running a task normalizes it — walking the `bind` spine — to exactly one of two shapes. This pair is the stable contract shared by `handle`, the host trampoline, and durable storage:

```json
{ "done": 42 }
{ "pending": { "name": "http.get", "args": ["https://example.com"], "resume": { "$params": ["__v"], "$return": "..." } } }
```

`resume` is an ordinary self-contained closure `(value) => <task>`: apply it to the effect's result to continue. Because escaping-closure capture keeps it self-contained, a `pending` record is plain JSON — persist it, ship it across a process boundary, print it as shorthand, or apply it **more than once** (multi-shot).

## `handle` — interpreting effects in-language

`handle(task, clauses)` runs a task, dispatching each effect it performs to a matching clause in the `clauses` record. This is a pure, in-language interpreter for effects — no host involved — which is what makes effectful code testable. This two-argument form is **partial**: unmatched effects bubble.

`handle(task, clauses, { "$raw": resultSchema })` is the **total annotated** form, written in shorthand as `handle task returns ResultType with { … }`. Its immediate result is checked against `resultSchema` at runtime, and the checker gives the expression that declared type. An unmatched effect is a `RuntimeContractError` instead of a residual task. The annotation is retained by every generated `resume`, and named types resolve through the active module's `$types`.

Clause lookup is by effect name:

- A **named clause** `"http.get": (url, resume) => …` receives the effect's args spread positionally, then `resume` last.
- The reserved **`"*"` wildcard** clause `"*": (eff, resume) => …` catches any otherwise-unmatched effect and receives `eff = { name, args }` plus `resume`.
- The reserved **`"return"` clause** `"return": (v) => …` runs when the task completes normally with value `v`; its result is final and is **not** re-interpreted by this handler. Without a `"return"` clause, `handle` returns the completion value directly.

For an annotated total handler of `Task<A>` with result annotation `R`, the
checker contextually types each manifest-backed clause as
`(...effectArgs, resume: (effectResult) -> R) -> R` and types `return` as
`(A) -> R`. Wildcard and built-in `raise` payloads remain broad because
`Task<A>` does not track an effect row or raised-payload type. The unannotated
partial form has no declared `R`, so it retains its imprecise static result.

`resume` is itself plain JSON built by `handle`, so continuations stay serializable mid-handle and multi-shot resumption is free: calling `resume` twice re-runs the rest of the task twice (the basis for nondeterminism, retry, and backtracking combinators).

**Bubbling.** In the partial form, an effect with no matching clause (and no `"*"`) is _not_ an error: `handle` re-performs it, wrapping the surrounding continuation so it re-enters the same handler afterward. The effect bubbles outward to the next enclosing `handle`, and ultimately to the host. This is what lets a partial handler discharge only the effects it cares about while staying transparent to the rest of the effect set. The annotated form is total and rejects the same unmatched effect.

For a function result annotation such as `(State) -> Report`, validation installs a serializable callable boundary. The function value is checked when produced; each eventual argument and return value is checked when it is called. This is what lets a state handler declare its actual immediate result:

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

Handler clauses are invoked through the normal call path, so fuel and call-depth metering apply; task normalization additionally charges fuel per interpreted node.

## Host trampoline

`handle` interprets effects _in-language_; to connect a task to the real world,
a host drives it with `runTask` (in TypeScript, exported from the package).
The host prepares a deployment from portable contract/profile data and
executable runtime-adapter bindings:

The two portable artifacts are specified separately:

- the [environment contract](../../deployment/environment-contract.md) owns boundary schemas,
  direct functions, effects, and the production entry;
- the [deployment profile](../../deployment/deployment-profile.md) selects a live or durable
  hosting mode, an effect subset, and portable execution limits.

```ts
const contract = {
  version: 1,
  $defs: {
    /* shared domain schemas */
  },
  functions: {
    /* direct host callable contracts */
  },
  effects: {
    /* capability argument/result contracts */
  },
  entry: {
    name: "main",
    required: [],
    optional: [],
    returns: { task: { type: "string" } },
  },
};

const profile = {
  version: 1,
  mode: "live",
  effects: ["io.readLine", "io.print"],
};

const deployment = prepareDeployment({
  module,
  contract,
  profile,
  adapter: {
    functions: {},
    effects: {
      "io.readLine": async () => prompt(),
      "io.print": async (msg) => {
        console.log(msg);
        return null;
      },
    },
  },
});
const result = await runTask(deployment, [], {
  signal,
  timeoutMs: 30_000,
});
```

The host is the _outermost handler_: any effect that no in-language `handle` discharged bubbles all the way out to `runTask`, which

- returns the value on `{ done }`;
- throws `TaskRaiseError` (carrying the guest payload) for an unhandled `raise`;
- throws `UnhandledEffectError` for an effect with no capability;
- otherwise `await`s the capability, applies `resume` to its result, and loops.

The contract and profile are portable JSON data, separate from host
implementations. `prepareDeployment({module, contract, profile, adapter})`
validates and links them once. The `RuntimeAdapter` must bind exactly all contract
functions and exactly the effects executed inline by that profile; profile
effect selection is allowed to be a subset of the contract. See
[Environment contract](../../deployment/environment-contract.md) and
[Deployment profile](../../deployment/deployment-profile.md) for the complete JSON shapes,
collision rules, validation APIs, and runtime-adapter requirements.

Entry calls accept every argument count from the required length through the
combined required-plus-optional length; supplied optional arguments are still
validated against their schemas. Entry returns have two forms:

- `entry.returns: A` describes an immediate result. The host invokes the entry
  once and validates that value directly; it does not interpret task-shaped
  data returned under a direct contract.
- `entry.returns: { task: A }` describes a task whose eventual completion value
  matches `A`. The host drives this form through the task trampoline and
  dispatches capabilities for effects that reach the host.

Despite its compatibility-preserving name,
`runTask(preparedLiveDeployment, args, hostLocalRunOptions?)` executes either
declared entry mode. It validates entry arguments and results, wraps tractable
direct host functions to validate their arguments/results, rejects effects
absent from the contract, validates outgoing effect arguments before invoking
host code, and validates capability results before resuming task entries. Named
references use the same merged builtin/contract/module definition pool as the
checker. Portable `maxCallDepth`, `maxFuel`, and `maxValueSize` limits belong in
the profile; the optional third argument is only for host-local cancellation,
timeout, and instrumentation.

Task entries may persist across process boundaries under a durable profile. See
[Deployment profile](../../deployment/deployment-profile.md) for durable selection and
runtime-adapter binding, then [Durable task hosting](../../runtime/durable-host.md) for store consistency,
delivery, recovery, and at-least-once execution semantics.

`jfn check --contract <path>` loads the same artifact, preloads its named
types, functions, and effects, and checks the entry body contextually against
the contract-owned signature. `jfn eval --contract <path>` prepares a live
deployment with an empty effect selection and empty runtime adapter, then executes the
contract entry. It is therefore suitable only when the contract has no direct
host functions and every task effect is handled in-language (or no effect is
performed). By default `eval` reads shorthand; pass `--json-input` to evaluate
canonical json-fn JSON directly.

Adding `--function <name>` selects a development evaluation instead: the CLI
uses the shared module linker, then invokes that named module function. An
environment contract may be supplied but is not required for self-contained
modules. This mode skips entry argument validation, entry return validation,
and automatic task execution. Success in this mode does not show that the
production entry can run. Test production hosting with `prepareDeployment` and
the real profile and runtime adapter; the CLI does not synthesize their
implementations.

**Durable suspend/resume.** A stepped `pending` record is host state, not itself
a task accepted by `serializeTask`. Hosts may serialize its `resume` closure (or
a task that embeds that continuation), but production durable hosting should use
the workflow-record codec and durable driver described above.

**Static admission.** `analyzeDeploymentCapabilities({ module, contract,
profile })` reports possible names, dynamic access, profile bindings, and
uncovered effects. A host can reject uncovered capabilities before running. It
is a conservative over-approximation and does not subtract effects discharged
by an in-language `handle`.

**Idempotency caveat.** `runTask` answers each `pending` exactly once, but durable suspend/resume makes **at-least-once** effect execution the practical reality: a crash between running a capability and persisting the resumed task reruns that effect on recovery (the same tradeoff as Temporal). In-language multi-shot `resume` is a feature; at the host boundary, replay is not free — capabilities with external side effects should take idempotency keys.

