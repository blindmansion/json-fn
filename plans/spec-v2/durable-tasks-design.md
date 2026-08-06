# Design notes: durable tasks for spec v2

Status: **design exploration, not a proposal.** Collects the design space for
extending the task/effect system around the durable-workflow use case in
spec v2. Nothing here is settled; sections are ideas with their rationale and
tensions, intended to be broken apart into concrete proposals later. Assumes
the v2 context: no backwards-compatibility constraint, coordinated landing
with [`event-trace-cost-model.md`](event-trace-cost-model.md) and
[`strict-reads.md`](strict-reads.md), and the content-addressing work
([`../content-addressing/`](../content-addressing/)) including the celld/DO
target profile ([`../content-addressing/celld-do-target.md`](../content-addressing/celld-do-target.md)).

Design constraints inherited from the language, which every idea below must
respect:

- programs, continuations, and state are canonical JSON, hashable under the
  `jfn:*` domains;
- effects are the only boundary to the world; everything else is pure and
  deterministic;
- capability is granted by the operator through contracts, never claimed by
  the author;
- the host can always account for what ran (the event trace).

## 1. Failure taxonomy of long-running workflows

The extensions in this document are justified by concrete failure families,
not by feature symmetry. A workflow that suspends for hours to months —
network calls with retries, email/message replies, human approval,
long-horizon agent loops — fails in roughly six ways.

**F1. Nothing arrives.** The reply is never sent; the approver is on
vacation or has left; the webhook endpoint was deregistered. Without
deadlines as values and a defined post-deadline path, these workflows are
immortal: they cost hibernated storage forever, clutter every pending-work
view, and hide the workflows that _could_ still complete.

**F2. The world moved.** The quoted price expired; inventory sold out; the
customer already cancelled through another channel; the approver approved
against numbers that have since changed. The continuation captured state
that was true at suspension and is false at delivery. The failure mode is
not an error — it is _successfully executing the wrong thing_. This family
is the most dangerous and the least served by conventional workflow
engines.

**F3. Duplication.** At-least-once delivery meets non-idempotent effects.
The existing effectId dedup handles redelivery of one logical result;
it does not address retry policy (how many times, what backoff), error
classification (transient vs. terminal), or retry budgets across a
workflow's lifetime.

**F4. Partial completion.** Step three of five fails terminally after steps
one and two committed external writes. Recovery requires compensation —
the saga pattern — and compensation actions must themselves be durable:
recorded before the action they compensate, executable after a crash.

**F5. Races and supersession.** Approval vs. timeout vs. cancellation; a
newer request that obsoletes an in-flight workflow; two replies to the
same thread. Whichever arrives first should win, with defined semantics
for the losers. Timeout, cancellation, and supersession are all instances
of one shape: competing alternative deliveries.

**F6. Illegibility.** Hundreds of suspended workflows and no good answer to:
what is each waiting for, since when, from whom, what happens if it is
delivered, and is it still safe to deliver? Legibility is a correctness
feature at this horizon: F1, F2, and F5 are all _managed through_ the
pending-work surface.

A unifying observation: **human approval, agent decisions, and slow machine
replies are one shape** — an external decision that is slow, fallible, and
possibly stale by the time it arrives. The design should serve all three
with one mechanism, differing only in metadata (`kind`) and display, not in
semantics.

## 2. What the language uniquely enables

Three properties of json-fn are rare or absent in conventional workflow
engines. The v2 task system should be designed _around_ them rather than
merely compatible with them.

### 2.1 Speculative preview (from determinism)

Because effects are the only boundary and everything else is deterministic,
the host can run a suspended continuation forward against a _hypothetical_
delivery — halting at the next non-benign effect — without committing
anything. The result is a computed, trustworthy answer to "what happens if
this is delivered":

> If approved, this workflow will next attempt
> `payments.refund({amount: 1200, account: "acct_9f2c"})`.

This turns the pending-work surface (F6) from a description of the past
(what the workflow said it was doing) into a preview of the future (what it
will actually do). It serves human approvers and inspecting agents equally.
Preview depends on the effect taxonomy (§2.4) to know which effects are
benign to execute speculatively and where to halt.

### 2.2 Approvals bind to content (from hashing)

A continuation is canonical JSON with a `ValueHash`. An approval delivery
can therefore carry the hash of the exact continuation it approves, checked
at delivery: if the workflow migrated, was superseded, or otherwise changed
between review and delivery, the approval is automatically non-applicable
rather than silently applied to something the approver never saw. What was
approved is cryptographically what runs. Combined with preview (§2.1), the
reviewed artifact can include the projected next effects, making the
approval an informed one. This is a capability no code-versioned engine
offers, and it falls out of representation choices json-fn has already
made.

### 2.3 Guards: staleness as re-evaluable predicates (from purity)

F2 — the world moved — is addressed by attaching a **guard** to a
suspension: a pure predicate over (a) state captured at suspension, (b) the
delivered payload, and (c) a host-supplied snapshot (time, and optionally
the results of declared revalidation reads, §2.4). The guard is evaluated
at _delivery_ time, deterministically, and its evaluation and outcome are
events in the trace.

Guards make "should this still run?" checked code instead of judgment:

- a quote-approval suspension guards on `quote.expiresAt > now`;
- a refund guards on a revalidation read confirming the order is still in a
  refundable state;
- an agent-loop step guards on its plan hash still matching the current
  plan.

Guard failure is not an error; it is a defined outcome of the suspension
(an arm the author handles — decline, re-fetch, escalate, terminate).
Because guards are pure and their inputs are recorded, a guard decision is
replayable and auditable like everything else.

Open tension: how much host-snapshot vocabulary guards may read (`now` is
clearly needed; anything more starts to blur the effect boundary) — the
revalidation-read mechanism in §2.4 is an attempt to keep that vocabulary
closed.

### 2.4 An effect taxonomy in the contract

The contract currently declares effect names and schemas. Durable execution
wants one more axis: an operator-attested **interaction class** per effect:

- `read` — benign, no external mutation; the host may re-execute freely
  (for revalidation snapshots and speculative preview), may cache, and may
  memoize by argument hash;
- `idempotent-write` — safe under retry with the same arguments;
- `at-least-once-write` — duplication possible and tolerated downstream;
- `exactly-once` — requires the dedup token / effectId machinery, never
  speculatively executed, never retried without policy.

The taxonomy is an _attestation by the operator_, like everything else in
the contract: the language cannot verify it, but it can hold the host to
behaving consistently with it, and it becomes part of the audited,
hashed world. Preview halts at the first effect above `read`; retry
combinators refuse to wrap `exactly-once` effects without an explicit
policy; memoization is legal only for `read`.

## 3. Task algebra

Combinators earn their place here only if they have _durable_ semantics —
meaning: their intermediate states are suspendable, their outcomes are
trace events, and their interaction with recovery is defined.

**`select` / `race` — competing alternatives (serves F1, F5).** A
suspension with multiple arms: each arm is a delivery source (an effect
reply, an external signal, a deadline). First delivery wins; losing arms
are cancelled with defined semantics (their pending external requests get
a cancellation notice where the effect supports it; their compensation, if
any, does not run because they never committed). A deadline is _just an
arm_ — timeout is not special-cased anywhere else in the system.
Supersession is an arm listening on a "superseded" signal. This one
combinator subsumes timeout, cancellation, and racing replies.

**`all` / quorum (serves F5).** Wait for all of n deliveries, or n-of-m
(two of three approvers). Partial-arrival state is a suspension like any
other, visible in pending-work with per-arm status.

**`retry` as a wrapper (serves F3).** Policy wraps a task rather than
decorating every call site: error classifier (which failures are
transient), backoff shape, attempt ceiling, per-workflow retry budget.
Retries are trace events; a retried effect's attempts are visible and
counted. Refuses `exactly-once` effects absent explicit policy.

**`bracket` / `compensate` — sagas (serves F4).** Pairs a forward action
with a compensating task. The compensation task is persisted _before_ the
forward action commits, so a crash between action and completion still
knows how to unwind. Compensations compose in reverse order; running them
is itself durable execution (compensations can suspend, retry, escalate).
On this target the persistence is one cell-local transaction
(per [`celld-do-target.md`](../content-addressing/celld-do-target.md) §1).

**Static effect shape via a selective tier.** json-fn programs are already
data — essentially a freer monad whose instructions are effects. Where
composition is applicative or selective rather than fully monadic, the
complete effect graph of a workflow is _statically enumerable_: an operator
or reviewing agent can see everything a workflow could ever do, with
branch structure, before it runs. Fully dynamic (monadic) regions remain
available but are visible _as_ dynamic regions — the analysis reports
"beyond this point, effects depend on values." This extends the audit
story from "what capabilities does it hold" (the contract) to "what plan
does it have" (the program), and it is cheap precisely because programs
are already inspectable JSON.

**First-class temporal and resource values.** `@duration`, `@deadline`
(and plausibly `@money`, `@tokens`) as typed values with canonical
encodings. Agents cannot encode sensible durability configuration in a
language that cannot express "72 hours" without stringly conventions; and
deadlines must be values the type checker and the guards can talk about.

## 4. The authoring surface: per-task configuration under operator bounds

The request: when writing a do block, each task can carry configuration
appropriate to that task — and agents, who write most of this code, should
be able to encode operational intent directly.

The design risk: per-site configuration must not become per-site
_capability_. The existing three-layer split (contract / profile / host)
already answers this; per-task config slots in as a fourth voice that is
**bounded by the contract**:

1. **Contract (operator):** declares, per effect, which durability knobs
   exist and their bounds — retry ceilings, allowed deadline range, whether
   escalation is available and to which channel classes, which guard
   snapshot vocabulary is exposed. The taxonomy class (§2.4) lives here
   too.
2. **Author (usually an agent):** writes per-site configuration within
   those bounds, in the program itself:

   ```jsonc
   // illustrative surface syntax, not a syntax proposal
   quote <- effect.getQuote(sku) with {
     retry: { max: 5, backoff: exp("1s", "60s"), on: "transient" },
     timeout: "30s",
     validFor: "24h"
   }
   approval <- effect.approve(quote) with {
     kind: "human",
     deadline: "72h",
     onDeadline: "escalate",
     guard: fn(s, delivery, snap) => s.quote.expiresAt > snap.now,
     display: {
       title: "Refund approval — order {orderId}",
       summary: "Customer requested refund of {amount} against quote {quoteId}."
     }
   }
   ```

3. **Profile (portable policy):** default config where sites are silent,
   selected per effect, as today.
4. **Host (local):** binds executables — the actual escalation channel, the
   actual clock, the queue.

Config outside contract bounds is a **check-time error**, reported at the
site, before anything runs. Authored config is part of the program JSON:
hashed into module identity, diffed in review, visible in audit. Agents
encoding rich operational intent never means agents granting themselves
anything — the bounds model preserves the capability story exactly.

Two elements deserve first-class status rather than convention:

- **`display` metadata.** The pending-work surface (F6) is only as good as
  what sites say about themselves. Structured display metadata — title,
  summary, referenced values — is something agents write well and humans
  need. It should be schema'd (in the contract's knob declaration), not
  freeform.
- **Deadlines surface in envelope metadata.** The host schedules wakes
  (DO alarms on the celld target) from deadlines; per the envelope rule,
  scheduling must read inline metadata only, never hydrate a payload.
  Whatever the config surface looks like, active deadlines project into
  the envelope.

Open question: is `with`-config attached to the _effect call site_ (as
sketched), to the _task value_ (wrapping combinator style, composing with
§3), or both with defined precedence? Combinator attachment composes
better; site attachment reads better and is likelier to be what agents
produce. Precedence rules if both exist need to be boring.

## 5. Pending work as a queryable, previewable surface

Consolidating F6: a suspended workflow's public description should be
computable entirely from inline envelope metadata plus (optionally) a
speculative preview pass, and should include:

- what it awaits: effect name, `kind` (human / agent / machine), per-arm
  status for `select`/quorum suspensions;
- since when, and the active deadline(s) and their `onDeadline` paths;
- authored `display` metadata;
- guard status: whether the guard _currently_ passes against a fresh
  snapshot — computable on demand because guards are pure and revalidation
  reads are `read`-class ("this approval is still valid" / "this would be
  rejected as stale: quote expired 2026-08-01");
- the continuation hash (the thing approvals bind to, §2.2);
- on request, the preview: projected next effects under a hypothetical
  delivery (§2.1).

The taxonomy makes guard-status and preview _safe_ to compute; purity makes
them _true_. This section is mostly a consumer of §2 — it earns its own
heading because it is the operational payoff and should be designed as a
surface, not left as an emergent property.

## 6. Evolution: checkpoints, migrations, and reachability

Extends the module-identity-pinning work
([`../content-addressing/module-identity-pinning.md`](../content-addressing/module-identity-pinning.md))
and the resume-under-pinned-world option
([`celld-do-target.md`](../content-addressing/celld-do-target.md) §3) from
_detecting and surviving_ drift to _evolving on purpose_.

**Named checkpoints.** Author-declared, named, stable resumption points —
the places a workflow's interior state is a supported migration surface.
Between checkpoints, continuations are implementation detail (pin or
reject, as today); _at_ a checkpoint, the state has a declared name and
schema, and migration is defined. This bounds the migration problem from
"resurrect an arbitrary interior continuation under new code" to "map
checkpoint state N to checkpoint state N+1," which is tractable and
testable.

**Migration functions as values.** A migration is a pure, typed function
from the old world's checkpoint schema to the new world's — itself
canonical JSON, hashed, reviewed, and (naturally) stored content-addressed
alongside the worlds it maps between. Migration policy per checkpoint:
migrate-at-wake, migrate-lazily-at-next-suspension, or run-to-checkpoint
under the pinned world and migrate there.

**Reachability classification.** Because modules hash by subtree, a deploy
diff identifies exactly which subtrees changed; a suspended continuation
identifies exactly which code it can still reach. The host can therefore
auto-classify every in-flight workflow on deploy:

- **unaffected** — no changed subtree is reachable from the continuation:
  resume freely under the new world, no policy needed;
- **affected** — apply policy: reject, accept, resume-pinned, or migrate at
  the next checkpoint.

This is the piece that makes rapid, natural code evolution real rather
than survivable: most deploys touch code most sleeping workflows will
never reach, and the system can _prove_ that per workflow instead of
applying one blanket policy. It requires the static effect/reference
analysis to be sound over the canonical form — a place where the selective
tier (§3) and strict semantics generally make the analysis stronger.

## 7. One substrate: the durable event trace

The event-trace cost model
([`event-trace-cost-model.md`](event-trace-cost-model.md)) already
introduces a closed vocabulary of semantic events determined by value
semantics. Nearly everything in this document wants to _be_ an event in
that vocabulary: effect attempts and retries (§3), guard evaluations and
outcomes (§2.3), deliveries won and lost in a `select` (§3), compensations
registered and run (§3), migrations applied (§6), config resolved at a
site (§4).

The design bet: **persist the trace, content-addressed, and make it the
single substrate** for —

- **budgets** that cross invocations: total fuel, total effect counts,
  spend/token budgets (declared in the contract, charged by effects,
  expressed as `@money`/`@tokens`) are folds over the durable trace —
  which per-invocation fuel cannot express and long-horizon agent
  workflows need;
- **audit**: the trace is the account of what ran, with hashes linking
  each event to the exact program, config, and world it ran under;
- **replay and recovery**: the recorded basis, as the cost-model plan
  already requires within an invocation, extended across the workflow;
- **observability**: §5's surface is largely a projection of trace +
  envelope.

One mechanism, four consumers — rather than a budget system, an audit log,
a replay journal, and a metrics pipeline that drift apart. The trace is
append-only and per-workflow, which on the celld target means it lives in
the cell, commits transactionally with the envelope, and hibernates at
object-storage prices; Merkle encoding applies to it like any other
growing value.

Cost tension to hold onto: the trace grows for the life of the workflow.
Trace retention/compaction policy (checkpoint-anchored truncation?) is an
open question with teeth, since compaction fights the replay-basis and
audit roles.

## 8. What is deliberately not here

- **No distributed transactions.** Sagas + idempotency + dedup are the
  consistency model; nothing coordinates commits across effects.
- **No workflow-to-workflow choreography layer.** Signals/supersession
  arms (§3) are the primitive; orchestration patterns compose from them
  in-language.
- **No liveness promises.** Deadlines and escalation manage F1; nothing
  guarantees an external party ever responds.
- **No per-site capability.** §4's bounds model exists precisely so this
  document adds zero new capability-granting surfaces.

## Candidate decomposition into proposals

Rough seams, in dependency order:

1. **Effect taxonomy + contract knob declarations** (§2.4, §4 layer 1) —
   everything else consumes it.
2. **Temporal/resource value types** (§3) — small, self-contained,
   unblocks config and guards.
3. **Guards and delivery semantics** (§2.3) — with the snapshot vocabulary
   question settled.
4. **Task combinators** (§3) — `select` first; it subsumes the most.
5. **Per-site config surface + bounds checking** (§4).
6. **Pending-work surface + preview** (§5, §2.1, §2.2) — host-facing,
   consumes 1–5.
7. **Checkpoints, migrations, reachability** (§6) — joint with the
   content-addressing follow-ups.
8. **Durable trace unification + cross-invocation budgets** (§7) — joint
   with the cost-model landing.
