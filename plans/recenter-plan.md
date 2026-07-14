# Type System Architecture Review & Recommendations

Status: external review of `typescript/` at commit `c1e53c5`, cross-checked
against `plans/type-sketch.md`, `plans/typecheck-plan.md`, and
`todo/typecheck-findings.md`, with findings reproduced through `jfn check`.

Framing constraint: **the primary authors are AI coding agents**, not humans.
The language is an embeddable, sandboxed runtime for agent-written code. This
changes the cost model — verbosity and explicit annotation are nearly free;
ambiguous or unreliable checker feedback is expensive, because the checker's
output *is* the agent's repair loop.

---

## 1. Verdict

**The core architecture is sound and does not need a ground-up rework.** The
foundational decisions are good and mutually reinforcing:

- JSON Schema as the canonical type representation, with the shorthand as a
  **gate** that can only emit a tractable fragment (§8 of the sketch). This is
  the strongest architectural asset — it's what keeps subsumption decidable and
  simple.
- Structural subsumption with coinductive `$ref` handling
  (`check/subsumption.ts`) — exact, small, and portable to the other language
  implementations.
- Substitution-based closures carrying `$sig` verbatim, so function values are
  self-describing JSON.
- The data-driven builtin table (`spec/builtins.json`, `$tvar` templates +
  overloads + `rule` escape hatches) as the single polymorphic layer shared
  across implementations.

The "flakiness" is real but concentrated, and — given agent authors — the
resolution is **stricter, simpler, and incapable of lying**, not smarter. The
recover-and-degrade behavior was the bolted-on part; the schema/subsumption
core was always exact.

---

## 2. Priority 1 — Kill silent degradation everywhere

The single biggest source of unreliability: the checker has many
"give up → `any`/`true`" paths, and there is **no distinction between
"checked and passed" and "wasn't checked at all."** A human feels this as
flakiness; an agent reads `No type errors` and moves on. Every silent `→ any`
is a lie told to the repair loop.

Known degradation paths (all verified):

| Path | Current behavior | Change |
| --- | --- | --- |
| Dangling `$ref` (typo'd / undeclared type name) | resolves to top; `f: () -> Reprot => true` checks clean | **Hard error.** Declare-before-use pass over all `$ref`s in `checkModule` (keep the intentional `type X = any` alias behavior — only *undefined* names error) |
| Missing-field access on a closed object | silently types as `null` | **Hard error** (masks typos) |
| Un-annotated top-level module function | body unchecked, value is `any` | default `requireTypedModuleFunctions: true` (flag already exists) |
| Unknown callee / unknown var | `any` | keep the degrade, but **count and report it** (below) |
| `handle` | top | see §6 |
| IIFE scope-object call (`do` with a local) | `any` | fixed by check-mode recursion, §3 |

Additionally:

- **Coverage reporting.** `jfn check` should report how much of the module was
  actually checked (e.g. count of expressions that synthesized through a
  degradation path), so an agent harness can gate on "fully checked," not just
  "zero errors." An info-tier diagnostic per degradation site
  ("expression degraded to `any` because <reason>") is the simplest form.

---

## 3. Priority 2 — Make `check()` actually bidirectional + structured diagnostics

The plan promises bidirectional checking, but `check()` today is
synth-then-subsume everywhere except lambdas at builtin call sites
(`inferLambdaReturn`). Making check-mode **recurse structurally into composite
literals** — push expected object-field types into fields, expected element
types into array elements, the expected type into `$if`/`$cond`/`$match` arms,
and an expected `$fnType` into un-annotated lambdas in any checked position —
fixes a whole family of filed findings at once:

- Bare capability-record lambdas synthing to `true` (blocks `thermostat.jfn`'s
  `Device`): the field's expected `() -> Task` is never pushed into the lambda.
- Object assignability errors that dump both whole schemas: structural
  check-mode naturally produces **field-level, pinpointed** diagnostics
  ("field `extra` not permitted", "required field `name` missing").
- Literal-union widening cosmetics (`if ... then 10 else 20`): arms checked
  against an expected type don't need to synthesize `const` unions.
- The `do`-block IIFE erasing to `any`: an inline body callee should have its
  `$return` type propagated (synthesize/check the body, return its return
  type) instead of falling through `bodyFnTypeSchema → true → sig === null`.

The `synth`/`check` seam already exists in `checker.ts`; the work is filling in
the check-mode cases.

**Structured diagnostics:** add `jfn check --json` emitting the `Diagnostic`
records (stable `path`, `message`, `severity`, `expected`, `actual`) directly.
Everything needed is already stored; agents repair far better from structured
errors with schema paths than from prose. Error locality directly determines
repair-iteration count.

Related diagnostic fixes in the same effort tier:

- Overloaded-builtin failures should report **all** failed overloads (or the
  nearest), not just the first (`length(123)` never mentions the `string` arm).
- Surface the swallowed type-parse error in `looksLikeFuncLit` /
  `returnTypeEndsInFatArrow` (the try/catch currently causes a malformed
  return annotation to be reported as an unrelated error at the parameter
  colon).

---

## 4. Priority 3 — Freeze narrowing; ship `!`; collapse the warning tier

**Reversal of the human-authored recommendation.** Flow narrowing exists to
spare human authors from restructuring code or writing casts. Agents don't
need sparing — and deterministic, simple rules are easier for models to learn
and remain stable across model generations, whereas "does the checker narrow
through this shape?" is exactly the fuzzy boundary agents probe and
misremember. The original v1 decision (sketch §5.5: no clever flow analysis,
explicit assertion operator) was right for this audience.

Concretely:

1. **Freeze narrowing** at roughly the current working set: truthiness,
   `isNull`/type predicates, and discriminant equality (`==` on a literal /
   static path) for `$if`/`$cond` — on params and eager bindings. Write a
   short spec that *documents* this set (which condition forms produce facts,
   composition under `not`/`$and`/`$or`) and table-test it. This is
   documentation of what exists, not a rebuild.
2. **Fix the one bug found**: in `factsFromCondition`, a bare-var condition
   that resolves as a named boolean guard recurses into the binding expression
   and returns `{}` when it yields no facts, instead of falling back to
   `truthinessFact` on the var itself. This is why `if h then h else 0`
   narrows for a param but not a `where`-local. One-line fallback.
3. **`match` subject narrowing**: include it in the frozen set — it's the same
   discriminant machinery `cond` already has (absence, not difficulty), and
   `match subject.tag { ... }` is the natural tagged-dispatch shape agents
   will emit constantly.
4. **Ship the `x!` assertion operator** (type spec §9) — it currently doesn't
   even parse. It should insert a runtime-checked cast node, so soundness is
   preserved at the sandbox boundary. This becomes the *sanctioned* discharge
   path for unions in locals, replacing further narrowing ambition.
5. **Collapse the warning tier.** The narrowable-mismatch → warning downgrade
   was anti-false-positive-fatigue design for humans. For agents a warning is
   an ambiguous signal. With `!` available, most warnings become **errors**:
   prove it with a recognized guard, or assert it and eat a runtime check.
   Make the `$match` exhaustiveness / dead-case lints errors too.
6. **Do not loosen callback arity.** Requiring the wrapper lambda
   (`map((x) => g(x), xs)`) is verbose but mechanical; agents will just do it,
   and the subtyping rule stays simpler. (Reverses the earlier
   loosen-for-idiom recommendation.)

The narrowed-memo / free-var re-synthesis machinery for lazy locals can then
stay as-is or be simplified — it no longer needs to grow.

---

## 5. Signature-precision work (fits the existing design cleanly)

- `fromEntries : ([string, V][]) -> { [string]: V }` — projecting the pair's
  second element into `additionalProperties`. This needs a small `CODE_RETURNS`
  rule (or a tuple case in `unifyTemplate`), *not* just a signature edit: the
  current template resolver can't bind a var inside a tuple/object. Also audit
  the remaining bare object-producers — `merge` is already done via a
  `CODE_RETURNS` rule; `values`/`entries` remain and hit the same gap.
- Stdlib sentinel cleanup: `find` already returns `T | null`. The open items
  are the index-returners `findIndex`/`indexOf` (still `-1`), where the honest
  type is `integer | null`.

---

## 6. Effects: annotated `handle`, no user-facing generics

The case for real `Task<A>` generics was human ergonomics. For agents, the
cheap resolution is fine and preferable:

- `handle` takes (or requires) a **declared result type annotation**; the
  checker trusts it statically and the runtime **validates it at the
  boundary**. Handler-produced and host-supplied values are exactly the
  untrusted inputs the §6 runtime-boundary model was built for — a sandboxed
  embedding wants this validation anyway.
- `Task` stays opaque/nominal; `perform`/`pure`/`bind`/`raise` keep their
  current `Task`-returning floors.
- User-facing generics stay excluded, preserving the shorthand gate.

This is a small change to the `handle` rule floor instead of a type-system
feature, and it resolves the last hard blocker in `thermostat.jfn`
(`runScript -> Report`).

---

## 7. Smaller fixes (roughly one sitting each)

- `where` at expression top level: either make it parse everywhere the error
  message recommends it, or fix the `let ... in` removal message.
- `Index`/parse ergonomics: `head([])` rendering `false` in the element slot,
  nested `anyOf` flattening, literal-union widening in rendered types (partly
  subsumed by §3's check-mode).
- Refinement UX note stands: refined types (`Score = integer & min(0)`)
  remain opaque to arithmetic; when it comes up, the agent-era answer is the
  same `!`/boundary-validation path as §4.4, not static refinement inference.

---

## 8. Suggested sequencing

1. §2 dangling-`$ref` error + missing-field error + `requireTypedModuleFunctions`
   default — small, immediate trust wins.
2. §4.2 `factsFromCondition` fallback bug + §4.3 `match` narrowing — unblocks
   most `ledger.jfn` / `thermostat.jfn` warnings.
3. §3 bidirectional check-mode (capability records, IIFE `$return`,
   field-level errors) + `--json` diagnostics.
4. §4.4 `x!` parse + runtime cast node; then §4.5 warnings→errors flip.
5. §5 `fromEntries`-family templates; §6 annotated `handle`.
6. §2 coverage reporting; §4.1 narrowing spec + table tests.

Success criterion: `examples/typed/ledger.jfn` and `examples/typed/thermostat.jfn` check
clean **without** their `-checked` cousins' restructurings (modulo explicit
`!` where a local union is discharged), and a fully-`any` module no longer
reports `No type errors` without also reporting what it didn't check.