# json-fn Effects & Capabilities — Design Sketch

Status: **draft / design sketch**. Consolidates a design discussion about adding
first-class effects (Effect.ts / Haskell-IO / algebraic-effects style) to
json-fn, grounded in the current TypeScript implementation (`evaluate.ts`,
`stdlib.ts`, the shorthand parser) and the existing host-integration and
execution-limits docs.

Decisions marked **[D]** are recommended; open questions are gathered at the end.

---

## 1. Core idea

Instead of performing side effects, programs **describe** them as values. An
effectful computation is an inert JSON tree of effect nodes; nothing runs until
an _interpreter_ walks it. Interpreters can be:

- the **host** at the runtime boundary (performing real I/O),
- an **in-language handler** (`handle ... with { ... }`) that reinterprets
  effects purely (mocks, retries, dry-runs, readers, nondeterminism).

This composes with **capability-based security**: effect _constructors_ are
only reachable through capability records passed explicitly into the entry
point. Code that wasn't handed a `db` capability provably cannot describe a
database effect that the host will interpret.

### Why json-fn is unusually well-suited

The two ingredients that are expensive in other runtimes already exist here:

1. **Inert JSON is a first-class concept.** The `raw()` WeakSet marking plus
   `$literal`/`$raw` is exactly the mechanism effect trees need. Crucially,
   `callFunctionInternal` already raw-marks every function _result_ — so a
   tagged record built by a constructor function is automatically inert.
   Effect nodes need **no new expression type**.

2. **Closures are substituted JSON (`replaceVars`) and the language has zero
   mutation.** A continuation is a fully-closed, serializable JSON value, and
   re-invoking it is side-effect-free by construction. **Multi-shot `resume`
   is free**, which unlocks backtracking/nondeterminism handlers that other
   runtimes struggle to support.

Additionally, the existing host pattern (see `typescript/examples/life.ts`)
is already the degenerate form of this design: a pure function returns a
record describing output/state/exit-code, and the host performs it. The
effect system generalizes that single round trip into a composable trampoline.

Contrast with Effect.ts / Haskell: their thunks are opaque; json-fn's effect
trees are plain JSON. That yields capabilities they _can't_ have:
serialization, structural diffing, dry-run introspection, audit logging,
cross-machine shipping, and deterministic replay.

---

## 2. Value representation

**[D]** Effect values are tagged plain records produced by constructors
(never written literally by users):

```jsonc
// perform("http.get", [url])
{ "@task": "effect", "name": "http.get", "args": ["https://…"] }

// pure(42)
{ "@task": "pure", "value": 42 }

// bind(task, k) — k is an ordinary json-fn closure (a $return body)
{ "@task": "bind", "task": { …effect… }, "then": { "$params": ["x"], "$return": … } }
```

Notes:

- Constructor results are raw-marked, so the evaluator never re-walks them.
- The tag key must be chosen so `classifyExpressionType` can never misread a
  rehydrated tree (see §7 on serialization). A non-`$` reserved key (shown
  here as `"@task"`) avoids the shorthand rule forbidding `$`-keys in data
  objects; alternatively a `$`-key that is constructor-only. **Open.**
- An `Error`/`raise` node is just a distinguished effect name (§5).

---

## 3. Recommended changes (revised feature list)

The evaluator needs **no new node types**. The full system is:

### 3.1 `do` notation — shorthand-only

New surface syntax mixing effect bindings (`<-`) with existing pure bindings
(`:`), ending in a final expression:

```jfn
greet: (io) => do {
  name <- io.readLine(),
  upper: toUpper(name),          // plain `:` = pure binding, no sequencing
  _    <- io.print(`hello ${upper}`),
  pure(upper)
}
```

Desugars in the parser to nested `bind(eff, (x) => rest)` calls — comparable
in complexity to the existing `where` desugar. Zero evaluator changes; spec
coverage lives in `spec/parse-cases` only. Since shorthand currently exists
only in TS, this does not block Go/Python/Rust.

**[D]** Effects are strict in sequence; interleaved `:` bindings keep normal
lazy-local semantics.

### 3.2 Stdlib constructors — pure builtins

`perform(name, args)`, `pure(x)`, `bind(task, k)` returning the tagged
records above. Trivial in all four implementations. Library combinators
(`mapTask`, `forEachE`, `retry`, `orElse`, `collectEffects`, …) can then be
written in json-fn itself.

### 3.3 `handle` — one native builtin

```jfn
testRun: () => handle greet(io) with {
  "readLine": (resume) => resume("world"),
  "print":    (msg, resume) => resume(null)
}
```

Semantics: walk the task tree; for each effect node, if a clause matches the
effect name, invoke it (via the builtin's existing `call` callback) with the
effect args plus a `resume` closure representing the rest of the `bind`
chain; unmatched effects **bubble outward** to enclosing handlers (and
ultimately to the host). Fuel is charged automatically through the existing
`call` chokepoints; add cost-table entries to `docs/execution-limits.md`
(each interpreted effect node should charge like a call).

`handle` _could_ be pure json-fn library code (the tree is data, closures are
callable), but a native builtin is cleaner for resume-wiring and metering.

**[D]** `resume` is multi-shot. The purity of the language makes re-entry
safe and free; this unlocks nondeterminism/search handlers (§6.5).

Surface syntax `handle … with { … }` is shorthand sugar over the builtin
call `handle(task, handlersRecord)`.

### 3.4 `raise` — a distinguished effect, not a feature

The language currently has **no in-language error handling at all** — every
failure is a host exception. Errors-as-effects fills this gap: `raise(err)`
is `perform("raise", [err])`; `catch`, `retry`, `orElse` are library
functions over `handle`.

**[D]** Evaluator/sandbox errors (fuel exhaustion, var-not-found, depth)
remain host-fatal — programs must not be able to catch their own limits.

### 3.5 Host trampoline — `runTask`

A sibling to `callProgram`, host-side only:

```ts
// Pseudocode
async function runTask(module, entry, args, capabilities, limits) {
  let result = callProgram(module, entry, args, registry, limits);
  while (isEffectNode(result)) {
    const perform = capabilities[result.name]; // enforcement point
    if (!perform) throw new UnhandledEffect(result.name);
    const value = await perform(...result.args); // real async I/O here
    result = callFunction(result.then, [value], registry, limits);
  }
  return result;
}
```

Each hop is a fresh **synchronous** evaluation (the evaluator never changes);
the host loop is where async lives. This slots into the existing
`host-integration.md` advice: build the module scope once, reuse it across
hops; per-hop `AbortSignal`/deadline/fuel apply as today.

**Capability enforcement lives here**: the host only installs interpretations
for effect names it granted. Unforgeability therefore does **not** depend on
preventing node construction — a hand-forged effect node simply has no
interpreter. (Attenuation = wrapping a capability record in a weaker one
before passing it down; pure library code.)

**[D]** The registry stays the _ambient_ zone and should stay pure under
capability discipline (today `log` is the one ambient impure tap — precedent,
but also the pattern to migrate away from for sandboxed programs). The
existing impure-host-function escape hatch remains for embedders who opt out.

### 3.6 Supporting sugar (small but load-bearing)

- **Method-call syntax**: capability ergonomics want `caps.db.query(sql)`,
  i.e. calling a property-access result. Today that spells
  `(caps.db.query)(sql)`. A P1-style shorthand item.

---

## 4. Type-system hooks (future)

When the JSON-Schema-backed type system lands (`docs/type-sketch.md`):

- `Task<A, E>` — or `Task<A, E, R>` with an **effect row** `R` naming which
  effects may appear in the tree — as the type of effect values.
- `do` typechecks like async/await over `Task`.
- `handle` **removes rows from `R`**: handled effect names are discharged, so
  "all effects handled" becomes a compile-time fact (the Effect.ts/Koka trick).
- Capability record types double as the security-audit surface: a function's
  signature states the maximum authority it can exercise.

None of this blocks shipping the untyped semantics first.

---

## 5. Frictions and design cautions

1. **Serialization loses inertness.** `raw()` is a WeakSet;
   `JSON.stringify`/`parse` drops the mark, and a rehydrated tree containing
   `$return` closures would be re-walked by `replaceVars` on re-entry (mostly
   harmless since they're closed, but not principled). For the
   serialize/replay superpower, define a canonical `serializeTask` /
   `hydrateTask` pair (e.g. durable `$literal` wrapping). Decide early.
2. **Tag choice** (§2): must be invisible to `classifyExpressionType` and
   compatible with the shorthand `$`-key rule.
3. **Conformance is the real budget.** Four implementations + normative spec:
   nail `handle` semantics (bubbling, multi-shot, lazy-local interaction) in
   `spec/cases` before Go/Python/Rust catch up. The stdlib-builtin approach
   minimizes surface — one builtin per impl, not a new node in four
   tree-walkers.
4. **Laziness interaction**: an effect value sitting in an unreferenced lazy
   local never runs (same as `log` today) — this is correct and should be
   spec'd as such.
5. **Cost model**: effect construction charges like object construction;
   interpretation charges like calls; host-side real I/O is governed by the
   existing wall-clock/abort mechanisms, not fuel.

---

## 6. Use-case snippets

### 6.1 Database — `do` + capabilities + transactions

```jfn
{
  findUser: (db, id) => do {
    rows <- db.query(`select * from users where id = ?`, [id]),
    match length(rows) {
      0 -> raise({ tag: "NotFound", id: id }),
      else -> pure(rows[0])
    }
  },

  // The body is an unexecuted tree, so `transaction` needs no macros:
  // the interpreter wraps it in BEGIN/COMMIT and treats `raise` as ROLLBACK.
  transferCredits: (db, fromId, toId, amount) => db.transaction(do {
    from <- findUser(db, fromId),
    _    <- if from.credits < amount
              then raise({ tag: "Insufficient", have: from.credits, need: amount })
              else pure(null),
    _    <- db.execute(`update users set credits = credits - ? where id = ?`, [amount, fromId]),
    _    <- db.execute(`update users set credits = credits + ? where id = ?`, [amount, toId]),
    pure(amount)
  })
}
```

### 6.2 Network — retry/fallback as tree-to-tree functions

```jfn
{
  fetchJson: (http, url) => do {
    res <- http.get(url),
    cond {
      res.status == 200 -> pure(parseJson(res.body)),
      res.status == 429 -> raise({ tag: "RateLimited" }),
      else -> raise({ tag: "HttpError", status: res.status, url: url })
    }
  },

  // Not primitives — pure functions over effect trees. `retry` re-runs the
  // WHOLE task, legal only because tasks are re-interpretable values,
  // not spent promises.
  retry: (n, task) => handle task with {
    "raise": (err, resume) => cond {
      n == 0 -> raise(err),
      err.tag == "RateLimited" -> retry(n - 1, task),
      else -> raise(err)
    }
  },

  orElse: (primary, fallback) => handle primary with {
    "raise": (err, resume) => fallback
  },

  getWeather: (http, city) =>
    retry(3, orElse(
      fetchJson(http, `https://api.primary.example/wx?city=${city}`),
      fetchJson(http, `https://api.backup.example/weather/${city}`)
    ))
}
```

### 6.3 UI — effects, or the Elm architecture

Handler style (UI runtime is just another interpreter):

```jfn
confirmDelete: (ui, item) => do {
  choice <- ui.dialog({ text: `Delete "${item.name}"?`, buttons: ["Cancel", "Delete"] }),
  match choice {
    "Delete" -> do { _ <- ui.toast(`Deleted ${item.name}`), pure(true) },
    else -> pure(false)
  }
}
```

Elm style (pure `update` returns state + a _command as data_ — unit-testable
by structural equality, no mocking framework):

```jfn
update: (state, msg) => match msg.tag {
  "Input" -> {
    state: { query: msg.value, results: state.results, loading: true },
    cmd: debounced(300, search(msg.value))
  },
  "Results" -> {
    state: { query: state.query, results: msg.items, loading: false },
    cmd: none()
  },
  else -> { state: state, cmd: none() }
}
```

### 6.4 Testing, mocking, dry runs

```jfn
{
  syncOrders: (caps) => do {
    since  <- caps.kv.get("lastSync"),
    orders <- fetchJson(caps.http, `/api/orders?since=${since}`),
    _      <- forEachE((o) => caps.db.execute(`insert into orders ...`, [o.id]), orders),
    now    <- caps.clock.now(),
    _      <- caps.kv.set("lastSync", now),
    pure(length(orders))
  },

  // Every effect interpreted purely — no I/O anywhere.
  testSync: () => handle syncOrders(testCaps) with {
    "kv.get":     (key, resume) => resume("2026-01-01"),
    "kv.set":     (key, val, resume) => resume(null),
    "http.get":   (url, resume) => resume({ status: 200, body: `[{"id":1},{"id":2}]` }),
    "db.execute": (sql, args, resume) => resume(null),
    "clock.now":  (resume) => resume("2026-07-07")
  },

  // Dry run: perform nothing, collect the trace. Writable as pure library code.
  dryRun: (task) => collectEffects(task)
  // -> [{ effect: "kv.get", args: ["lastSync"] }, { effect: "http.get", args: [...] }, …]
}
```

### 6.5 Non-IO effects (unlocked by handlers)

```jfn
{
  // Reader/config
  makeGreeting: () => do {
    cfg  <- ask("greeting"),
    name <- ask("name"),
    pure(`${cfg}, ${name}!`)
  },
  withConfig: (env, task) => handle task with {
    "ask": (key, resume) => resume(env[key])
  },

  // Nondeterminism — multi-shot resume = branching search
  pythagorean: () => do {
    a <- choose(range(20)),
    b <- choose(range(20)),
    c <- choose(range(20)),
    if a*a + b*b == c*c && a > 0 && b > 0 then pure([a, b, c]) else fail()
  },
  allSolutions: (task) => handle task with {
    "choose": (xs, resume) => flatMap(resume, xs),   // resume called many times
    "fail":   () => []
  }
}
```

---

## 7. Suggested implementation path (TS-first)

1. Constructors (`perform`/`pure`/`bind`) + tag decision + raw-marking.
2. `handle` builtin + semantics writeup + `spec/cases` + cost-table entries.
3. Shorthand: `do` desugar; `handle … with { … }` sugar; method-call syntax.
4. Host `runTask` trampoline + a real example (port `life.ts` to
   capability-driven I/O — it is already the degenerate case).
5. Library layer in json-fn: `retry`, `orElse`, `catch`, `forEachE`,
   `collectEffects`, attenuation helpers.
6. `serializeTask`/`hydrateTask` for the replay/audit story.
7. Go/Python/Rust: constructors + `handle` builtin against the spec cases.

Rough scope for TS end-to-end: comparable to P4 name resolution; the spec
work is the long pole.

---

## 8. Open questions

- Exact tag key for task nodes (`@task` vs. constructor-only `$`-key).
- Bubbling semantics details: does an unhandled effect escaping the top of a
  `handle` re-wrap the surrounding continuation correctly? (Needs spec cases.)
- Should `handle` clauses receive effect args spread (`(msg, resume)`) or as
  a single record (`({name, args}, resume)`)? Spread reads better; record
  generalizes to wildcard handlers (needed for `collectEffects`). Possibly
  both: named clauses spread, a reserved `"*"` clause gets the record.
- Serialization format for tasks containing closures (durable inertness).
- Whether `raise` unhandled at the very top surfaces as a host exception or a
  structured result from `runTask`.
- Effect-row syntax in the future type shorthand (`Task<A, E, R>` vs. rows on
  the arrow).
