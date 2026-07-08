# Effects Implementation Plan

Status: **concrete plan**, TS-first. Successor to `plans/effects-sketch.md` (which
holds the rationale; this doc holds the build order). Assumes **method-call
syntax** (`caps.db.query(sql)`) is already landed before work starts.

Design stance settled in prior discussion: the semantic kernel is minimal —
three constructors + one `handle` builtin + a host trampoline. Everything else
(retry, state, errors, dry-runs) is guest library code, which works *because*
escaping-closure capture makes continuations self-contained. Naturalness comes
from shorthand (`do`, `handle … with`), which is parser-only.

---

## 1. Task representation

Tagged plain records, produced only by constructors, raw-marked on construction
(`raw()` in `typescript/src/utils.ts`) so the evaluator never re-walks them.

```jsonc
// perform("http.get", [url])
{ "@task": "effect", "name": "http.get", "args": ["https://…"] }

// pure(42)
{ "@task": "pure", "value": 42 }

// bind(task, k) — k is an ordinary closure, self-contained via escaping-closure capture
{ "@task": "bind", "task": { …task… }, "then": { "$params": ["x"], "$return": … } }
```

Decisions (previously open in the sketch, now fixed):

- **Tag key: `"@task"`.** Not a `$`-key, so `classifyExpressionType`
  (`evaluate.ts` ~line 1111) classifies a rehydrated node as a plain Object and
  never misparses it; the shorthand data-object rule forbidding `$`-keys
  (`parser.ts` `parseDataObject`) is untouched. Users *can* forge one via a
  data object or `raw` island — harmless authority-wise, because enforcement
  is host-side: a forged effect name simply has no interpreter. Forged
  *malformed* nodes (e.g. a `bind` whose `then` is not a closure) must fail as
  clean guest-visible evaluator errors, not TS exceptions — `stepTask`
  validates shape (Phase 2 spec cases).
- **Handler clause signature:** named clauses get effect args spread plus
  `resume` last — `"http.get": (url, resume) => …`. A reserved `"*"` clause
  gets the record form — `"*": (eff, resume) => …` with
  `eff = { name, args }` (needed for `collectEffects`-style wildcards).
- **Reserved `"return"` clause** (classical algebraic-handler return case):
  when the handled task completes normally with value `v`, a `"return"`
  clause, if present, is applied as `(v) => result` and its result is final —
  not re-interpreted by this handler. Without it, `handle` returns `v`
  directly. This is kernel, not convenience: value-shaping patterns like the
  state handler (§2) are otherwise expressible only via an awkward
  pre-compose idiom (`handle bind(task, (x) => pure(wrap(x))) with { … }`).
- **`raise`** is `perform("raise", [err])` with a convenience constructor.
  Evaluator/sandbox errors (fuel, depth, var-not-found) stay host-fatal.
- **Unhandled `raise` at the top of `runTask`** throws a host-side
  `TaskRaiseError` carrying the JSON payload (not a structured return).

### The suspended form (public contract)

Normalization (`stepTask`, Phase 2) reduces any task to one of two shapes, and
this pair — not the raw `bind` spine — is the **documented, stable contract**
that hosts, `handle`, and durable storage all share:

```jsonc
{ "done": <value> }
{ "pending": { "name": "http.get", "args": […], "resume": { "$params": ["v"], "$return": … } } }
```

`resume` is an ordinary self-contained closure (escaping-closure capture is
what guarantees that), so a `pending` record is plain JSON: persist it, ship
it, print it as shorthand, or answer it — possibly more than once. This is the
thing you write to a database for durable workflows; giving it a spec'd name
and shape is deliberate.

## 2. Target usage

Effectful greeter — `do` mixes effect bindings (`<-`) with pure locals (`:`):

```jfn
{
  greet: (io) => do {
    name  <- io.readLine(),
    upper: upper(name),
    _     <- io.print(`hello ${upper}`),
    pure(upper)
  },

  // Pure test: every effect interpreted in-language, no host involved.
  testGreet: () => handle greet(mockIo()) with {
    "io.readLine": (resume) => resume("world"),
    "io.print":    (msg, resume) => resume(null)
  },

  // Capabilities are guest code: records of closures over `perform`.
  mockIo: () => {
    readLine: () => perform("io.readLine", []),
    print: (msg) => perform("io.print", [msg])
  }
}
```

The `do` block desugars (parser-only) to:

```jfn
bind(io.readLine(), (name) =>
  bind(io.print(`hello ${upper}`), (_) => pure(upper)) where { upper: upper(name) })
```

State that feels stateful but is a pure handler (multi-shot-safe). Every
clause — including `"return"`, which lifts the completion value — yields a
function awaiting the threaded state, so the whole handled expression is
applied to `s0`:

```jfn
counter: () => do { c <- perform("get", []), _ <- perform("put", [c + 1]), pure(c) },
withState: (s0, task) => (handle task with {
  "get":    (resume) => (s) => (resume(s))(s),
  "put":    (s1, resume) => (s) => (resume(null))(s1),
  "return": (v) => (s) => v
  // wildcard omitted; unhandled effects bubble to the host
})(s0)
```

Host side — the trampoline is where async and capability enforcement live:

```ts
const result = await runTask(module, "main", [], registry, {
  "io.readLine": async () => prompt(),
  "io.print": async (msg) => { console.log(msg); },
}, limits);
```

Durable suspend: when `runTask` hits an effect its capability table defers,
the `{ pending: { name, args, resume } }` record is plain JSON —
`JSON.stringify` it, store it, and days later `hydrateTask` + resume.
Escaping-closure capture guarantees `resume` is self-contained (recursion and
captured locals travel with it).

## 3. Phases

### Phase 1 — Constructors (`perform`, `pure`, `bind`, `raise`)

Files:

- `typescript/src/stdlib.ts` — four new registry entries. Plain `builtin(...)`s
  that validate shape (`perform`: string name + array args), build the tagged
  record, and `raw()` it before returning. Note `callFunctionInternal` already
  raw-marks results (`evaluate.ts` ~line 422), but marking explicitly in the
  builtin keeps the invariant local. Registry key `pure` coexists fine with
  the `pure` marker helper imported from `utils.ts` (key vs. value); alias the
  import if it reads badly.
- `typescript/src/types.ts` — a `TaskNode` type union + `isTask()` guard
  (export from `utils.ts` or a new `task.ts`; `handle` and the host loop share it).
- `spec/cases/effects-constructors.json` — structural expectations: `pure(42)`
  returns the tagged record; `bind` nests; constructed tasks pass through
  object/array literals inert; a task in an unreferenced lazy local never
  evaluates anything (laziness interaction, sketch §5.4).

Done when: `bun test` green; constructed tasks survive being stored in
data structures and returned from closures unchanged.

### Phase 2 — `handle` builtin

Files:

- `typescript/src/task.ts` (new) — `stepTask(task)`: normalize a task to the
  public suspended form (§1) — `{ done }` or `{ pending: { name, args, resume } }`
  — by walking `bind` spines (compose nested continuations in JSON:
  `resume = (v) => bind(k1(v), $raw k2)`). Shared by `handle` and Phase 4's
  `runTask`.
- `typescript/src/stdlib.ts` — `handle: builtin((args, call, _fns, meter) => …, 2)`.
  Loop: `stepTask`; on `{done}` apply the `"return"` clause if present (its
  result is final — not re-handled) else return the value; on an effect, look
  up the clause by name, else `"*"`, else **bubble** (below). Invoke clauses
  through the existing `call` chokepoint so fuel/depth metering is automatic; charge
  `meter.charge(1)` per interpreted node (cost-table entry in
  `docs/language.md` § Execution Limits: interpretation charges like a call).

Key mechanics:

- **`resume` is plain JSON**, built by the builtin — not a host function —
  so continuations stay serializable even mid-handle and multi-shot is free:

  ```jsonc
  { "$params": ["__v"],
    "$return": { "$fn": ["handle",
      { "$fn": ["bind", { "$fn": ["pure", { "$var": "__v" }] }, { "$raw": k }] },
      { "$raw": handlers } ] } }
  ```

- **Bubbling:** an unmatched effect returns a new task whose continuation
  re-enters this handler:
  `bind(perform(name, args), (v) => handle(bind(pure(v), k), handlers))`
  (same JSON-construction trick). This *is* the answer to the sketch's open
  question about re-wrapping the surrounding continuation — pin it in spec cases.

Spec (`spec/cases/effects-handle.json`):

- basic interpretation (`pure` passthrough, single effect, chained binds)
- bubbling through one and two nested `handle`s
- multi-shot `resume` (nondeterminism: `choose`/`fail` → `flatMap(resume, xs)`)
- `raise` caught by a `"raise"` clause; `"*"` wildcard receives `{ name, args }`
- `"return"` clause: lifts the completion value; absent → value passes
  through; its result is not re-interpreted; the full `withState` example
  from §2 runs end-to-end
- handler clause that ignores `resume` (early exit / `orElse`)
- forged/malformed `@task` nodes (`bind` with non-closure `then`, `effect`
  with non-string name or non-array args) fail with clean guest-visible
  errors (`error` field in the spec case), never a host-language exception
- **the load-bearing interaction case:** a recursive `where`-local effectful
  loop whose suspended continuation escapes `handle` and still works
  (escaping-closures × bind chains — model on `spec/cases/escaping-closures.json`)

The existing runner (`typescript/test/run-cases.ts`) needs no changes —
`handle` is just a registry builtin.

Done when: all snippets in §2 above run under `bun test`; fuel accounting
covered by a case in the style of `spec/cases/fuel-limits.json`.

### Phase 3 — Shorthand: `do`, `handle … with`

Files: `typescript/src/shorthand/parser.ts`, `printer.ts`, lexer untouched
(see `<-` note), `docs/shorthand-spec.md`, `spec/parse-cases/`.

Parser:

- `do` and `handle` become contextual keywords in `parsePrimary` (alongside
  `if`/`cond`/`match`). Breaking change: `do`/`handle` stop being usable as
  bare identifiers in primary position — grep `examples/` and note in the spec.
- **`<-` without a lexer token.** Lexing `<-` as one token would break
  `x < -1`. Instead the do-binding parser accepts token `lt` immediately
  followed by `minus` with adjacent positions (tokens carry `line`/`col`;
  require `col_minus == col_lt + 1`, same line). Only do-binding position
  looks for this, so expression syntax is unaffected.
- `do { … }` grammar: comma-separated entries, each either
  `ident <- expr` (effect binding), `ident : expr` (pure binding, reuses
  `parseBody` so trailing `where` works), or a bare expression. A bare
  expression as the **final** entry is the block's result; a **non-final** bare
  expression is a *discard* — an effect run only for its side effect, like
  Haskell's `e >> rest`. Desugar: each `<-` (and each discard) starts a nested
  `bind(expr, k)`; the continuation `k` is built with the existing `buildScope`,
  with any pure bindings since the previous entry attached as its lazy locals.
  An effect binding's `k` binds the result to its `ident`; a discard's `k` takes
  **no parameter** (a zero-param continuation), so the result is dropped — this
  is a distinct JSON shape from `_ <- expr` (which binds `_`), so both surface
  forms preserve distinct JSON and print back to themselves. Pure bindings
  *before* the first entry wrap the whole chain in a zero-arg IIFE, exactly like
  expression-level `where` (`parseBody`, parser.ts ~line 462). `_` is an
  ordinary parameter name.
- `handle expr with { "name": clause, … }` lowers to
  `{ $fn: ["handle", expr, { …clauses… }] }`. Clause keys follow data-object
  key rules (dotted names like `io.readLine` need quotes).

Printer (`printer.ts`): sugar-print only exact desugar shapes, preserving the
bijective-by-normal-form guarantee that `print-spec.test.ts` enforces
(`parse(print(json)) === json`): a `bind` call whose second argument is a
function literal prints as `do { … }` (folding nested binds and their
where-locals back into `<-`/`:` entries); a `handle` call with an object
literal second argument prints as `handle … with { … }`. Anything else — e.g.
`bind` with a `&`-referenced continuation — prints as plain calls.

Spec: `spec/parse-cases/do-notation.json`, `spec/parse-cases/handle.json`
(source ↔ expected canonical JSON, which also feeds the printer round-trip
corpus via `print-spec.test.ts`).

Done when: §2's `.jfn` examples parse, print, and round-trip.

### Phase 4 — Host trampoline: `runTask`

Files:

- `typescript/src/host.ts` (new) — exported from `src/index.ts`:

  ```ts
  export async function runTask(
    module: Record<string, JSONType>, entry: string, args: JSONType[],
    registry: FunctionRegistry,
    capabilities: Record<string, (...args: JSONType[]) => Promise<JSONType> | JSONType>,
    limits?: ExecutionLimits,
  ): Promise<JSONType>
  ```

  Loop: `callProgram` once, then while the result normalizes to `{ pending }`
  (via `stepTask`): on `raise` → throw `TaskRaiseError(payload)`; on unknown
  name → throw `UnhandledEffectError(name)`; else
  `await capabilities[name](...args)` and re-enter via
  `callFunction(resume, [value], …)`. Each hop is a fresh synchronous
  evaluation with per-hop fuel/deadline/`AbortSignal` (reuse the `limits`
  plumbing from `callFunction`, `evaluate.ts` ~line 210). Build the module
  scope once and reuse across hops (mirror `callProgram`'s `buildScope` usage
  — may need a small internal export or a `prepareProgram` helper so hops
  don't re-close-over the module each time). `runTask` resumes each `pending`
  exactly once — but durable workflows make **at-least-once** effect execution
  the practical reality (a crash between performing the capability and
  persisting the resumed state reruns the effect on recovery, same as
  Temporal). In-language multi-shot `resume` is a feature; at the host
  boundary, replay is not free.
- `typescript/src/host.ts` also gets `serializeTask` (assert-and-stringify —
  contents are already plain JSON thanks to escaping-closure capture) and
  `hydrateTask` (parse + walk + `raw()`-mark every `@task` node and closure
  body, restoring inertness lost to the `raw()` WeakSet — sketch §5.1).
- `requiredCapabilities(module | task): string[]` — static admission check: a
  pure walk over the JSON collecting effect names, i.e. first args of
  `{ $fn: ["perform", <literal string>, …] }` calls plus `name` fields of
  embedded `@task` nodes (dynamic names report as an `{ dynamic: true }`
  marker so hosts can refuse them). This is Effect.ts's `R` parameter computed
  from data instead of tracked by types: a host can enumerate what a program
  could ever ask for *before* running it, and reject at admission time instead
  of hitting `UnhandledEffectError` mid-run. Lives in `host.ts` next to
  `runTask`; a guest-code sibling over already-built tasks belongs in Phase
  5's `collectEffects` family.
- `typescript/examples/life-effects.ts` — port `life.ts` to capability-driven
  I/O (the sketch calls it the degenerate case; make that literal).
- `typescript/test/host-trampoline.test.ts` — host-only semantics that
  `spec/cases` can't express: async capability round-trips, unhandled
  effect/raise errors, suspend → `serializeTask` → new process simulation →
  `hydrateTask` → resume, per-hop abort, `requiredCapabilities` against a
  module with static, dynamic, and handler-discharged effect names.

Done when: `life-effects.ts` runs interactively and the serialize/resume test
passes against a continuation containing a recursive `where`-local.

### Phase 5 — Guest library

`examples/effects-lib.jfn`: `mapTask`, `andThen`, `forEachE`, `catch`,
`retry`, `orElse`, `collectEffects` (wildcard-clause dry-run), `withState`,
plus an attenuation helper (wrap a capability record in a narrower one).
No import system yet, so this ships as a documented example module; its
behavioral coverage lives in `spec/cases/effects-lib.json` using the suite
level `functions` field (`run-cases.ts` already merges suite functions into
the registry).

This phase is also the acceptance test for the kernel: **everything here must
be expressible with zero new builtins.** If something isn't, the kernel is
wrong — fix `handle`/`stepTask`, don't add a primitive.

### Phase 6 — Docs & conformance handoff

- `docs/language.md`: new "Tasks & Effects" section (representation, the four
  constructors, `handle` semantics incl. bubbling + multi-shot + `"return"`
  clause, laziness interaction), stdlib entries, Execution Limits cost rows.
  Host-integration guidance must state the idempotency caveat explicitly:
  capabilities with external side effects should take idempotency keys,
  because durable suspend/resume implies at-least-once execution and the
  language's pure-replay semantics make rerunning look deceptively free.
- `docs/shorthand-spec.md`: `do` and `handle … with` grammar + desugar rules,
  the `<-` adjacency rule, contextual-keyword note.
- `plans/effects-sketch.md`: mark superseded-by-this-plan; fold the resolved
  open questions in.
- Go/Python/Rust are explicitly out of scope (they lag anyway per AGENTS.md);
  the spec cases from Phases 1–3 and 5 are their catch-up contract.

### Phase 7 (optional) — CLI

`jfn eval` already prints returned task values as JSON/shorthand, which is
enough for inspection. Optional: a `jfn run` command wiring `runTask` with a
tiny built-in console capability set (`io.print`, `io.readLine`) so examples
are runnable without a host script. Defer until Phase 4 shows what's wanted.

## 4. Considered alternative: direct-style `perform` (rejected for v1)

An outside review proposed a different route to the *same* host contract
(§1's `{ done } | { pending }` shape is adopted from it): make `perform` a
direct-style expression — no `bind`, no `do` — and have the **evaluator
suspend** when it hits one, reifying "the rest of the computation" into the
`resume` closure via a CPS or explicit-stack (defunctionalized-continuation)
tree-walker. Guest code would read like plain code:

```jfn
userReport: (id) => `${user.name}: ${str(length(posts))} posts` where {
  user:  perform("http.get", [`/users/${id}`]),
  posts: perform("http.get", [`/users/${id}/posts`])
}
```

The appeal is real (no monadic surface at all), and the explicit-stack
evaluator would also enable a stepping debugger and precise pause/resume.
Rejected for v1 on three grounds:

1. **Native higher-order builtins can't reify their frames.** `map`, `filter`,
   `reduce`, `sort`, `groupBy`, `pipe`, … (`stdlib.ts`) are native loops that
   invoke guest callbacks through `call`. A `perform` firing inside a `sort`
   comparator would need to capture a continuation containing the middle of a
   *native* loop — not expressible as JSON. Every interpreter-aware builtin
   would have to be rewritten as in-language code or a resumable state
   machine, in all four implementations. Under bind/do this can't arise: an
   "effectful callback" just returns a task value; native loops stay native
   and sequencing a list of tasks is explicit library code.
2. **Direct-style effects in a lazy-binding language are `unsafePerformIO`.**
   `where` locals are lazy and demand-driven; today evaluation order is
   unobservable and implementations are free to choose it. Direct `perform`
   makes order observable, which forces demand order to become *normative
   spec* — freezing evaluation strategy into the conformance suite and making
   innocent refactors (inlining a binding) change a program's I/O. Haskell
   settled this: in a lazy language, effects must be sequenced by data (the
   monad / `<-`), not by evaluation. The `do` block's explicit sequencing is
   also an audit feature for a sandboxing language: the `<-` lines *are* the
   ordered observable events.
3. **The conformance multiplier.** A suspendable evaluator is a rewrite of the
   core tree-walker × four implementations × a normative suspension spec. The
   bind/do design is one builtin per implementation plus a TS-only parser
   desugar — the entire budget argument of the sketch.

Forward-compatibility: nothing here is lost. Koka/Effekt demonstrate that
direct-style effect syntax can be *lowered* to exactly this kind of
continuation representation once effect types exist to guide the transform
(`docs/type-sketch.md`'s future `Task<A, E, R>` rows). If direct style earns
its keep later, it lands as another parser/typechecker lowering onto the same
task values and host contract — the value model shipped now is the compile
target either way.

## 5. Explicitly deferred

- **Parallel join** (`all([taskA, taskB])`) — the one future primitive that
  passes the "guest code can't express it" test. Needs a fourth node kind and
  host support; nothing in Phases 1–6 should preclude it.
- Effect rows in the type sketch (`Task<A, E, R>`), `handle` discharging rows.
- Migrating `log` from ambient-impure to an effect.

## 6. Order & rough size

Phases 1–2 are one unit of work (constructors are trivial; `handle` +
semantics + spec cases is the core, comparable to a mid-size stdlib feature).
Phase 3 is comparable to the `where` desugar plus printer work. Phase 4 is
small TS, mostly test-writing. Phase 5 is cheap and fun and validates
everything before docs land in Phase 6. The long pole, as the sketch
predicted, is spec-case authoring in Phases 2 and 3 — budget accordingly.
