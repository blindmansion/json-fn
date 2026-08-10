# Plan: capture closures (Stage 2 chunk 2c)

Status: **spec text written**, 2026-08-09 — the rewrite surface below has
landed in `spec-v2/docs/`; the conformance-case consequences and hash-vector
pinning remain with 2g. Owns [`plan.md`](plan.md) Stage 2 chunk 2c.
The decision itself is settled — Proposal 1 with the record-on-value
encoding, adopted in [`review.md`](review.md) §4 ("P1 yes, P2 in spirit but
not in encoding"). This document plans the spec text: it restates the
adopted semantics in the vocabulary Stages 1/2a/2b established, pins the
rules that must be fixed while writing (each with a recommendation, so the
chunk is not blocked; none rises to a [`status.md`](status.md) decision),
maps the rewrite surface onto `spec-v2/docs/`, and states the hand-offs.
2c is written before 2d, so 2d reconciles the co-owned
`functions.md` hashing/printing text (the [`plan.md`](plan.md) note).

## The adopted semantics, restated precisely

A function value never has its body rewritten. Evaluating a function-body
expression creates a function value carrying the body exactly as authored
(post program normalization) plus a **capture record** — the evaluated
values of the body's free variables — as a sibling of `$params`/`$return`.
Capture happens at **creation**; there is no separate escape step, and
escape is the identity on a value that already carries its record.

Deleted with substitution:

- the substituter and its parallel scoping ruleset — the spec'd observable
  today is the substituted output itself (`closures.md` shows it), and every
  conforming implementation must replicate shadowing by `$params`,
  `$captures`, and nested `$let` inside it;
- the dedicated attach mode for escaping local functions — `$captures` as a
  special case for function bodies generalizes to one mechanism for values;
- the code/data confusion class substitution defends against with
  runtime-value marking: a record entry is **data by position**, so a
  captured value whose keys look like `$call` is never at risk of execution.
  Inertness survives serialization by construction — nothing is marked, so
  nothing is re-derived on hydration.

Preserved:

- **suspension self-containedness**: the suspended form's `resume` is closed
  JSON with no references to live host memory — attachment achieves what
  inlining achieved; the `{done}`/`{pending}` envelope is untouched;
- **multi-shot resume**: sharing one record across applications is sound
  because the language has no mutation;
- **by-name resolution** of module functions and builtins — never captured,
  resolved at the target host (the Proposal 9 version-skew residual,
  unchanged and restated, not resolved, here);
- **`$comment` preservation** on returned bodies — now trivially true, since
  the body is never rewritten.

Properties by construction, each a stated (testable) claim in the new text:

- the body subtree of any function value is byte-identical, under canonical
  encoding, to the corresponding normalized source subtree — suspended
  continuations hash and diff against the deployed program;
- escape is idempotent;
- record names cannot collide with parameter names (free variables exclude
  the body's own binders);
- each captured value is stored once, not spliced per reference site.

## Rules to pin while writing

### 1. The record's canonical shape

Recommend **keeping the key `$captures`**, re-specified: a plain object
mapping variable names to **captured values** (any JSON value, including
function values), a sibling of `$params`/`$return` alongside
`$runtimeContract`. The old payload (substituted function bodies only) and
the new (values) never coexist — Stage 2 is the one versioned body-format
break — and the name stays accurate; a rename (`$env`, `$capture`) buys
nothing and churns every mention. Posture unchanged from today: **not a
source field** — invalid in modules and authored expressions, present only
on evaluated function values.

Recommend the **empty record is omitted**, never `{}`: a combinator with no
free variables then has a value byte-identical to its source body, which
makes the byte-identity claim above exact rather than "modulo an empty
field".

### 2. The capture relation — 2a's edge rule viewed from the value side

2a's hand-off requires the dependency-edge rule and the capture rule to be
one sentence viewed from two sides. The free variables of a body are the
names it statically references — the same transitive `$var` / named-`$call`
/ `$fn` relation — minus the names its own parameter surface and inner
scopes bind. What each free name contributes:

- **value-position reference** to any in-scope binding (`$let` binding,
  enclosing parameter, enclosing capture, module value entry): an entry
  holding the **evaluated value**. 2a guarantees existence — value-position
  references create order edges, so the binding evaluated first.
- **call-position reference to a local function binding** (sibling or
  enclosing-`$let`, including self): the name stays a name in the body, and
  the record carries a **group entry** enabling by-name application after
  escape (rule 3). 2a's exemption means the sibling's *value* may genuinely
  not exist at creation time, so these entries cannot hold values — they
  hold program.
- **module functions and builtins**: by name, never captured (unchanged).
  Module *value* entries are captured by value — this is the other half of
  2a's module rule ("resumed continuations do not re-enter module entries:
  captured values ride the record").

One clarification to land in 2a's `expressions.md` text while here: the
call-position exemption removes the edge to the sibling *function*, but the
transitive relation continues **through** the call — the sibling body's own
value-position references propagate to the referencer. Creating `even`
(which calls `odd`, which reads `limit`) requires `limit`'s value in the
record, so `even` needs the order edge to `limit` even though it has none to
`odd`. The landed 2a text says references "directly or through transitive"
relations count; verify it reads unambiguously for the
through-the-exemption case and add one sentence if not.

### 3. Recursion — the record as a flat binding group

The one place attachment is not "store the value": genuine self- and mutual
recursion, where 2a's exemption means no order edge exists and the sibling
function's value may not exist when the escaping closure is created. What
always exists is the sibling's **source body** — program text, not a value.
Recommend generalizing exactly v1's flat-`$captures` mechanism:

- At creation, the **capture group** is the created function plus the
  transitive closure of call-position-referenced local function bindings.
- The record carries one **open-body entry** per group member referenced by
  name from the escaping body or from any member's body — the member's
  unrewritten literal binding value (its whole authored body object,
  preserving `$params`, `$comment`, and after 2d `$returns`), with **no
  record of its own** — plus one value entry per name in the union of the
  group's value-position free names.
- **Resolution when applying a function value `V`**: the current `$let`,
  then parameters and defaults, then **`V`'s record**, then module entries,
  then builtins — the existing five-tier order in `modules.md` with the
  record as tier 2's capture component. When a function-valued record entry
  is applied by name from within that scope, its body resolves through
  **the same containing record**: the record is one flat, mutually
  recursive binding group — semantically a `$let` whose bindings are
  already evaluated, which is why the local-binding audit rendering
  (rule 6) is faithful and not a pun.
- A member that is *both* called and taken as a value contributes by the
  static reference kind: any value-position reference forces the order edge
  (2a), so the value exists and is captured; call-position resolution can
  then apply that captured value — no open-body entry needed. Open-body
  entries appear only for members reached **exclusively** through
  call-position references. The rule depends only on static reference
  kinds, never on schedule accidents, so record shapes are deterministic.

Honest residue: a self-recursive escape duplicates its own body once (the
outer body and its own open-body entry), and every group member's record is
self-similar one level deep. This is v1's existing shape, it terminates by
construction (open bodies carry no records), in-memory sharing makes it
free, and content addressing dedups it at rest. The rejected alternative —
a `$self`/back-reference sentinel — introduces a new node kind and a cyclic
validation obligation to save bytes that CAS already saves.

### 4. Cost

No vocabulary change. Closure creation is **not an event** — keeping it out
of the closed event vocabulary is what keeps 2c inside Stage 2's single
break with nothing new to version:

- The record is **statically sized construction**: its entry set is a
  static function of the program text, so per D2 it folds into the
  containing region's static constant. Recommend the counting rule: **one
  count per record entry**, charged in the region containing the
  function-literal node. Captured values are shared, already charged at
  their production; open-body entries are static program text whose nodes
  charge as all function bodies do (verify Stage 1's node-counting
  treatment of nested function literals and phrase this rule compatibly).
  A closure created per loop iteration charges its entries per iteration,
  because each iteration re-enters the region — the materialization rule's
  named conformance vector (Stage 1 item 4, D2) is exactly this.
- Application is unchanged: invocation event (1) plus the callee's entry
  region. Applying a **hydrated** function value — a resumed continuation
  arriving as input — charges **re-entry (1)**; the record's cost was paid
  at the original creation and fuel does not cross suspensions. The
  language-side sentence lands here; the durable-host restatement is
  Stage 4 item 5.
- **Re-entry attachment audit**: substitution was what put runtime values
  in expression position, and that category dissolves with it. Pin what
  re-entry still attaches to — values arriving as input (hydrated
  continuations and function values applied from data) and the memoization
  cache-hit rule — and reword the runtime `execution-limits.md` bullet away
  from marking-flavored "existing runtime value" language. As with 2a's
  binding-force removal, a redefinition of attachment inside Stage 2's
  break, not a versioned addition.

### 5. Validation at value boundaries

Function values arrive as data — workflow records, host results, arguments
— and the record must be validated where today's `$captures` and
`$runtimeContract` are, fail-closed, at hydration/application rather than
by trusting shape:

- `$captures` must be a plain non-null object; names must be valid
  identifiers; names must be disjoint from the value's own `$params`
  binders (impossible from creation; enforced on hand-crafted input rather
  than given a shadowing meaning);
- open-body entries must be valid function-body shapes;
- in **source**, `$captures` stays invalid (the existing constraints-list
  line, wording updated from "captured function bodies" to the record).

Structural depth already names closure captures at boundaries — verify,
no new text. Error identity: recommend one validation error class naming
the offending field, matching the existing rehydration-validation posture.

### 6. Printing — audit rendering, not a source form

The record prints as the **local-binding form** (`where` today; Stage 5
flips the surface to `let … in` and this rendering follows automatically) —
the workflow state snapshot reads as bindings over the unrewritten body:

```jfn
(__v) => remaining(__v, cursor) where cursor: 42, cfg: { retries: 3 }
```

Pin the posture explicitly: this is **audit output for values, not a
source form**. The normative round-trip law `parse(print(node)) =
normalize(node)` is scoped to programs, and programs never contain records
(rule 5). Text that parses the rendering back yields a body-top eager
`$let` of literal values — semantically faithful (strict bindings of
evaluated values, callable by name: rule 3's observation) but not the
canonical value shape; value identity and interchange are the canonical
JSON itself (`jfn:value:v1`), never the rendering. Two consequences to
write down:

- a captured value that is expression-shaped data prints under the
  printer's existing inferred-`$raw` quoting, so the rendering never reads
  as code;
- the record scopes over **parameter defaults** as well as `$return`
  (today's rule, kept), which a body-top `where` cannot literally express —
  one more reason the rendering is a rendering. State the scope rule in
  `closures.md` normatively and let the rendering approximate.

The normalizer needs **no new rule**: program normalization never applies
to values, and canonical-JSON key sorting already covers record encoding.
Printer rule text is drafted here and assembled with the hash vectors in
2g.

### 7. Hashing

No new domains, no changes to `hashing.md` rules: function values are
values and hash under `jfn:value:v1`; program normalization (`jfn:module`)
never sees a record. What 2c adds is the **stated property** (in
`closures.md`, cross-referenced from `hashing.md`'s values-not-programs
paragraph if a sentence helps): the value's body subtree canonically
encodes byte-identical to the normalized source subtree, so a pending
continuation verifies against deployed source and the record diffs as a
state snapshot. Draft hash vectors for 2g: simple value capture; nested
closure (record entry that is itself a record-carrying function value);
self-recursive escape (open-body self entry); mutual group; captured
expression-shaped data; empty-record omission.

### 8. Two small calls

- **`$fn` semantics**: unchanged — `$fn` of a local function binding yields
  the (record-carrying) function value; `$fn` of a module function yields
  the by-name reference, exactly today's "name or body" rule restated over
  values. The open question about `&` at suspension boundaries (by-name
  `$fn` vs captured closure durability) stays a pending shorthand item in
  [`status.md`](status.md); 2c adds the note that the record now gives the
  captured alternative a precise meaning.
- **Checker surface**: light. Lexical checking of nested functions is
  untouched (the checker sees source, which has no records); the record
  tier joins the resolution order the checker mirrors, and validated
  hydration is a boundary, not a typing rule. Verify `narrowing.md` needs
  nothing (capture is value snapshotting; no narrowing interaction).

## Rewrite surface, file by file

Normative core:

- `spec-v2/docs/language/json/closures.md` — the primary rewrite, top to
  bottom: creation-time capture, the record shape (rule 1), the capture
  relation (rule 2), the flat group and resolution rule (rule 3),
  idempotence, the scope-over-defaults rule, the byte-identity property
  (rule 7), and worked examples — the curried `add` and countdown `go`
  examples redone showing record-carrying values in place of substituted
  output.
- `spec-v2/docs/language/json/functions.md` — the evaluated-function-value
  field list: `$captures` re-specified as the capture record; "Captured
  functions are available through `$var`, `$fn`, and `$call`…" generalizes
  to captured *values* (with call-position application for function-valued
  entries); the local-recursive-functions cross-reference updated. Co-owned
  with 2d, which lands second and reconciles the value-shape text
  (`$returns`, typed descriptors) against this chunk's record.
- `spec-v2/docs/language/json/modules.md` — the resolution-order list:
  tier 2's capture component becomes the record tier, with the group rule
  cross-referenced; "module functions are not copied into a closure's
  `$captures`" survives verbatim; the module-value-entries-are-captured
  consequence gets its one sentence, aligned with the 2a text already
  there.
- `spec-v2/docs/language/json/expressions.md` — light: the "evaluating a
  function body creates a closure" sentence points at creation-time
  capture; the constraints-list `$captures` line reworded; the rule-2
  clarification of transitive references through the call-position
  exemption, if the landed 2a text is found ambiguous.
- `spec-v2/docs/language/json/execution-limits.md` — a capture-cost
  paragraph beside the `$let` and property-access ones: record entries
  count in the containing region's static constant; creation fires no
  event; hydrated application charges re-entry (rule 4).
- `spec-v2/docs/runtime/execution-limits.md` — the re-entry bullet reworded
  per rule 4's attachment audit; one sentence marking the capture record as
  the named conformance vector for the statically-sized-construction rule;
  the versioning note mirrors 2a/2b's (attachment redefinition priced into
  the Stage 2 break).
- `spec-v2/docs/language/json/tasks-and-effects.md` — the suspended-form
  paragraph: `resume` is self-contained **by attachment**; a pending
  record's body verifies against source; `$runtimeContract` rides beside
  the record unchanged.

Consistency sweep:

- `spec-v2/docs/language/shorthand/function-literals-and-local-bindings.md`
  — the "Closures & recursion" section: the `$captures` sentence rewritten
  (serialized closure state → the capture record; still no shorthand
  source form; the audit rendering named); the nested-lambda example's
  canonical output updated if it shows substituted output.
- `spec-v2/docs/language/shorthand/files-and-program-shape.md` — "module
  functions are not copied into escaping closures" survives; verify no
  other sentence implies rewriting.
- `spec-v2/docs/language/shorthand/literals-and-data.md` — verify-only: the
  inferred-`$raw` text is what rule 6's rendering leans on; nothing to
  change unless it claims raw inference is source-only.
- `spec-v2/docs/language/json/index.md` — the `closures.md` line's
  description ("captured values and local functions") likely survives
  as-is; verify.
- `spec-v2/docs/guides/writing-jfn.md` — the closures paragraph in §6 gains
  the record story in one or two sentences (self-contained serializable
  values; state rides as a readable record, body stays your source); no
  new sharp edge to teach — this chunk is invisible to authors who never
  read persisted values.

## Hand-offs to sibling chunks

- **2d (`$fields` lowering + `$sig` inlining)** lands second and reconciles
  the co-owned `functions.md` value-shape and hashing/printing text: the
  function value after Stage 2 carries `$params`, `$return`, `$returns`
  (2d), `$captures` (2c), `$runtimeContract` — one field list, stated once.
  The lowering itself interacts trivially: lowered body-top projections are
  ordinary `$let` bindings, and the free-variable relation sees them as
  such. Open-body record entries preserve whatever 2d makes of the authored
  body (typed descriptors, `$returns`) byte-for-byte.
- **2a (strict `$let`)** — consumed, not changed: the edge rule and the
  capture rule are one sentence from two sides (rule 2), and the one
  candidate clarification (transitivity through the call-position
  exemption) is a verify-then-touch on landed text, coordinated so the two
  chunks keep telling one story.
- **2g (conformance assembly)** inherits the case consequences; drafted
  here, assembled there:
  - delete: substituted-output closure cases; raw-marking/rehydration cases
    predicated on substitution; any case asserting captured values appear
    in expression position;
  - rewrite: escaping-closure and captured-local-function cases to record
    shapes; suspended-form cases to attached records;
  - add: record-shape hash vectors (rule 7's list); the body
    byte-identity property; escape idempotence; resolution-order cases
    (record tier vs module entry vs builtin; group-internal by-name
    application; value-vs-open-body entry selection by reference kind);
    boundary-validation failures (rule 5); cost vectors (record entries in
    the region constant, per-iteration creation, hydrated application
    charging re-entry 1); multi-shot resume sharing one record.
  - Final printer/normalizer round-trip rules and the hash vectors are
    pinned in 2g once, for the whole stage.
- **Stage 3 (Proposal 7 audit)** runs against the final resolution order,
  which retains the record tier — rule 3's order statement is the input.
- **Stage 4** consumes rule 4's resume-time charging sentence (item 5) and
  considers the record under the workflow-record version field (item 2).
- **Cross-plan bookkeeping** (already tracked in [`status.md`](status.md)):
  the CAS measurement-gate re-baselining after Stage 2 lands, and the
  lazy-refs dependency note (partial hydration composes with records — one
  ref per entry).

## Acceptance criteria

- No body rewriting anywhere in the language: the body subtree of every
  function value canonically encodes byte-identical to the normalized
  source subtree, and a conformance vector asserts it.
- No marking: no normative sentence depends on identity-based inertness or
  hydration-time re-derivation; the record position is data by definition.
- Escape is idempotent and record shapes are deterministic (a static
  function of program text plus captured values), with name collisions
  impossible by construction.
- The resolution order is total and stated once, including the record tier
  and the flat-group rule for by-name recursion after escape.
- The cost story adds no event kind: records charge in region constants at
  creation, application is invocation as before, hydrated application
  charges re-entry 1, and the re-entry attachment list no longer mentions
  substitution-flavored categories.
- The suspension contract is unchanged at the envelope level; `resume`
  stays self-contained, serializable, and multi-shot — by attachment.

Format-visible changes originating here: the record's new payload semantics
on `$captures` (values and open bodies in place of substituted function
bodies) and the disappearance of substituted output from every function
value. Both are priced into Stage 2's single break; printer/normalizer rule
assembly and vector pinning stay with 2g, as for the whole stage.
