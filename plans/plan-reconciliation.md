# Reconcile the existing plans

Status: completed documentation pre-step (2026-07-29)

## Summary

Before implementing the broader roadmap, update the existing plan documents so
they describe one compatible architecture and do not assign the same work to
multiple efforts.

This is a documentation pass, not an implementation phase. Its output is a
coherent set of individual plans that can be referenced by
[`implementation-roadmap.md`](implementation-roadmap.md) without repeating
their detailed designs.

The most important corrections are:

1. give the `__proto__` integrity fix one owner;
2. separate canonical `$raw`, runtime-value identity, static-cost metadata, and
   future lazy storage references;
3. put fuel equivalence before program normalization;
4. redesign strict reads around information the runtime actually has;
5. separate semantic value hashes from physical blob hashes;
6. define the durable codec/store boundary before adding content-addressed
   storage; and
7. treat lazy refs as a later architecture project, not a direct extension of
   the at-rest codec.

## Reconciliation principles

Apply these rules while editing the individual plans:

- Give each semantic decision and implementation change one primary owner.
  Other plans should link to that owner and state only their dependency.
- Distinguish a **hard prerequisite** from ordering chosen to reduce rework or
  merge conflicts.
- Keep program-AST normalization separate from canonical encoding of arbitrary
  JSON values.
- Require serialization and cache metadata to be observationally irrelevant:
  losing ephemeral metadata must not change values, errors, or deterministic
  fuel.
- Do not claim host-layer transparency until the current host abstraction can
  implement the proposed behavior.
- Mark already-shipped findings and consciously deferred ideas as such.
- Keep the TypeScript implementation canonical; reconciliation of the lagging
  implementations remains outside these plans unless explicitly added later.

## Required updates by plan

### `raw-semantics-cleanup.md`

Keep this as the owner of the distinction between:

1. canonical `$raw`;
2. ephemeral runtime-produced value identity; and
3. ephemeral static-expression cost metadata.

Update it as follows:

- Make safe arbitrary-key object construction a prerequisite owned by
  [`runtime-representation-gaps.md`](runtime-representation-gaps.md), rather
  than a second implementation of the same `__proto__` fix.
- Define the exact `$raw` fuel equation, including whether the evaluator's
  already-charged expression-entry unit is part of the static literal cost.
- Move fuel equivalence before any normalizer is permitted to remove redundant
  `$raw` wrappers.
- Make shorthand `raw` removal, inferred quotation, and printer normalization
  one atomic compatibility change. The parser must not stop accepting syntax
  that the printer still emits.
- Describe parser-recorded static provenance as parse-time metadata, not a
  property reconstructed from lowered canonical JSON.
- Inventory every boundary that creates or restores runtime values: public
  entry arguments, parameter/local bindings, builtin and host results,
  callbacks, task construction, resumes, and durable hydration.
- Require centralized task/workflow rehydration to validate known shapes before
  restoring runtime-value marks.
- Require any newly introduced static-cost, normalization, or hydration walk to
  be iterative or subject to the depth contract owned by
  `runtime-representation-gaps.md`.
- State explicitly that the program normalizer is context-sensitive and is not
  a general JSON-value normalizer.

The revised phase order should be:

1. characterize runtime boundaries and current fuel;
2. introduce precise runtime-value APIs;
3. extract static-cost metadata;
4. centralize rehydration;
5. implement ingestion-independent `$raw` fuel;
6. atomically change shorthand inference and printing; and
7. migrate checker wording, tasks, examples, docs, and tests.

### `runtime-representation-gaps.md`

Keep this as the owner of host-representation leaks.

Update it as follows:

- Expand the `__proto__` work into a repository-wide arbitrary-key write audit,
  not only the parser and evaluator paths currently named.
- Specify the guest-object invariant: every JSON key becomes an own enumerable
  writable data property.
- Include parser, evaluator, closure transformation, checker-generated property
  maps, standard-library transforms/grouping, environment namespace
  construction, task serialization, and future codecs in the audit.
- Link the shared own-property helper as a prerequisite from
  `raw-semantics-cleanup.md`.
- Keep the structural-depth decision here. The choice is either a portable
  depth limit applied across all relevant traversals or iterative
  implementations for every accepted depth.
- Clarify that `maxCallDepth` does not cover expression-tree, parser, checker,
  closure, printer, normalization, hashing, or hydration recursion.
- Split the Unicode section into:
  - code-point semantics already implemented in TypeScript;
  - remaining performance/metering work; and
  - the selected policy rejecting ill-formed surrogate strings at language,
    host, persistence, and canonical-encoding boundaries.

The `__proto__` fix may land independently and should precede new generic
normalization or codec reconstruction.

### `strict-reads.md`

Rewrite this plan before implementation. Its current behavior table assumes
the runtime can distinguish required and optional reads, but canonical `$get`
currently carries only the evaluated target and key.

Choose one coherent design:

1. **Recommended:** all direct `$get` misses are strict; nullable/defaulting
   absence uses explicit operations such as `lookup` and a defaulting builtin.
2. Add a distinct canonical nullable-read operation.
3. Carry checked schema information into runtime evaluation as a larger typed
   execution artifact.

If the recommended design is selected, update the plan to acknowledge:

- missing optional fields also error under direct `$get`;
- checker projection for optional fields must change accordingly;
- computed tuple/closed-object reads already include `null` in some cases and
  need an explicit migration;
- `head` and `last` already have nullable general signatures and strict
  non-empty overloads;
- `hasKey` exists, while `lookup` and the proposed defaulting operation do not;
- string indexing must be explicitly included or excluded;
- runtime source spans are not currently available merely because checker
  diagnostics have positions; and
- existing null-on-miss conformance cases must be replaced in the same change.

Remove the claim that no checker typing changes are required.

### `content-addressing/content-addressed-values.md`

Keep this as the owner of the eager, at-rest content-addressed codec.

Update it as follows:

- Replace the assertion that finite acyclic JSON is guaranteed “by
  construction” with a defined persistence/hash boundary that rejects cycles,
  non-finite numbers, non-JSON values, and unsupported string encodings.
- Apply the lone-surrogate rejection policy from
  `runtime-representation-gaps.md` before an RFC 8785-style encoder receives a
  value; do not permit host replacement encoding.
- Define separate identities:
  - a semantic `ValueHash` over the complete canonical guest value; and
  - a physical `BlobHash` over a versioned chunk encoding.
- Include codec/chunk version and hash domain in physical addresses. A hash
  algorithm prefix alone is insufficient.
- Replace the proposed optional methods on the logical `WorkflowStore` with a
  specified physical envelope and codec/store ownership model.
- Preserve inline metadata needed for revision checks, `claim`, status scans,
  deployment identity, and corruption handling without hydrating the entire
  record.
- Specify atomic create/transition/claim behavior when blobs must be written
  before a referencing record.
- Extend the GC design with the enumeration/deletion and root-retention
  operations it actually requires.
- Decide terminal-record retention and what `read()` means after terminal blob
  collection.
- Make `"blob-missing"` a terminal workflow failure only if the physical
  envelope/store protocol can persist that transition safely; otherwise
  classify it as store corruption.
- Add measurement as a gate before building the blob layer: logical record
  sizes, repeated-subtree estimates, continuation expansion, hydration latency,
  memory, and expected read/write amplification.

Retain the required hydration order:

1. fetch and verify blobs;
2. decode and reconstruct plain JSON;
3. validate the complete logical record;
4. restore runtime-value marks through the centralized hydration pass; and
5. enter evaluation.

### `content-addressing/module-identity-pinning.md`

Keep this as the owner of automatic executable-world identity for durable
resume.

Update it as follows:

- Treat canonical JSON bytes and domain-separated hashing as the only shared
  dependency on the at-rest CAS plan; the blob store is not a prerequisite.
- Make normalized semantic module hashing depend on the completed `$raw` fuel
  and program-normalization work.
- Define whether the module component hashes the authored normalized module or
  the linked module with injected effects. Avoid counting the same contract
  change as both module and contract drift without intending to.
- Add an explicit engine/stdlib semantic version. Hashing
  `spec/builtins/builtins.json` alone does not detect implementation behavior changes,
  while hashing prose creates irrelevant drift.
- Specify the exact profile projection, including whether limits that alter
  durable outcomes are part of identity.
- Persist a versioned component manifest, not only an aggregate
  `identityHash`, so component-level diagnostics are recoverable.
- Define old-record behavior when identity fields are absent.
- Preserve the existing operator-provided `deploymentId` as a broader
  namespace/policy boundary.
- Default rejection should be non-mutating, like the existing deployment
  mismatch behavior. A mismatched deployment must not terminally fail a
  workflow that the correct deployment could still resume.
- Specify warning delivery and the bounded `resumedUnder` history before
  retaining `"warn"` as an option.
- Remove or qualify the claim that existing capability analysis already
  identifies all referenced builtins.

Version routing and explicit migration remain a separate future plan.

### `content-addressing/lazy-refs-and-cas-runtime.md`

Keep this deliberately deferred and strengthen its preconditions.

Add the following unresolved architecture requirements:

- Blob reads are asynchronous while the evaluator and task session are
  synchronous. Select async evaluation, complete prefetch, a synchronous local
  cache, or a new suspension mechanism before designing forcing.
- Use an unforgeable internal representation rather than an ordinary object
  shape that guest data could imitate.
- Base equality fast paths on compatible semantic value hashes, not merely
  physical chunk hashes.
- Do not make guest fuel depend silently on chunk thresholds or store state.
  Specify virtual inline-equivalent charges or explicitly version a
  non-portable execution profile.
- Correct the description of current `maxValueSize` enforcement before
  claiming no interaction.
- Expand memoization soundness beyond “do not memoize direct host functions”:
  guest functions can transitively call host functions, and cached execution
  must have defined fuel and failure behavior.
- Require a complete builtin forcing-depth audit and host-boundary forcing
  contract.

Keep the hard gates:

1. eager CAS shipped and measured;
2. a real hydration or memory bottleneck observed;
3. raw/runtime/static-cost separation landed;
4. semantic hashing available;
5. forcing architecture and fuel policy decided; and
6. module identity available before durable memoization.

### `module-where-blocks.md`

Keep this as an independent shorthand improvement.

Add the missing printer work: module binding values should print trailing
`where` without the parentheses still required for ordinary data-object entry
expressions. Preserve the distinction between module-body parsing and generic
object-entry parsing.

No evaluator, checker, or linker dependency should be added.

### `leading-pipe-unions.md`

Keep this as an independent type-shorthand change. The current scope is sound:
parser, type syntax documentation, printer round trips, and focused tests.

Note that diagnostics for currently malformed `|` placements may change when
the leading token becomes legal, and retain explicit negative cases such as
double separators and a missing type before `=>`.

### `effects-binding-scope.md`

Keep this as a documentation-only correction.

Expand the documentation audit to include every location in
`docs/guides/writing-jfn.md` that groups `effects` with unconditional injected or
reserved names, not only the two sections currently highlighted. Preserve
linker behavior and add a focused unlinked-module regression only if existing
coverage does not prove that a top-level `effects` binding is legal without a
contract.

### `positional-omission.md`

Mark this as a decision record rather than active implementation work.

Retain the current choice:

- literal `null` is supplied data, never omission;
- optional suffix parameters remain the positional mechanism;
- object-pattern parameters are the named-options mechanism; and
- call-site holes remain deferred until repeated authoring evidence justifies
  their canonical and runtime complexity.

If holes are reopened later, require a new plan to settle builtin calls,
canonical marker validation, trailing-hole normalization, arity, `apply`, and
boundary behavior rather than treating the current sketch as implementation
ready.

### `future-authoring-improvements.md`

Keep this as a parking lot, but prune or mark stale entries:

- bare recursive callback references already work; replace that item with any
  remaining diagnostic-specific issue or remove it;
- numeric `groupBy`/`countBy` key conversion is already documented in the main
  reference; retain only any desired addition to the concise authoring guide.

Keep array-pattern parameters, pipeline syntax, local types, annotated locals,
bodyless signatures, and width-aware printing as separate candidate ideas.
Local types should be described as substantially larger than adding a scoped
definitions map because escaping schemas and runtime validators need stable
lexical type identity.

## Cross-plan ownership after reconciliation

The resulting ownership should be:

- Host object integrity, depth, string validation, and Unicode metering:
  `runtime-representation-gaps.md`.
- `$raw`, runtime-value identity, static-cost metadata, hydration, fuel, and
  program normalization: `raw-semantics-cleanup.md`.
- Read-absence semantics: `strict-reads.md`.
- Canonical JSON encoding and eager at-rest blobs:
  `content-addressed-values.md`.
- Durable executable-world identity: `module-identity-pinning.md`.
- Runtime refs and memoization: `lazy-refs-and-cas-runtime.md`.
- Isolated shorthand/docs improvements: their individual plan documents.

## Completion criteria

Completed. The reconciled individual plans satisfy these criteria:

- every individual plan has an accurate status;
- shipped, deferred, and open work are visibly separated;
- no implementation change has two owners;
- all hard dependencies are linked in both directions where useful;
- the raw/fuel/normalization ordering is unambiguous;
- strict reads describes a runtime-representable design;
- the content-addressing plans agree on hash types and store ownership;
- module drift has a non-destructive default policy;
- lazy refs list async forcing and purity as explicit blockers; and
- [`implementation-roadmap.md`](implementation-roadmap.md) can reference the
  individual plans without restating their detailed designs.
