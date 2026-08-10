# Plan: the parameter surface (Stage 2 chunk 2d)

Status: **chunk plan**, 2026-08-09 — plans the spec text; nothing below has
landed in `spec-v2/docs/` yet. Owns [`plan.md`](plan.md) Stage 2 chunk 2d.
The decisions themselves are settled — Proposal 6's in-scope portion
([`review.md`](review.md) §7: "collapse `$fields`; scope carefully") and the
`$sig` inlining, adopted with
[`type-eval-coherence.md`](type-eval-coherence.md) (§1 piece 2 and §2) and
folded into [`plan.md`](plan.md) on 2026-08-08. This document restates both
changes in the vocabulary Stages 1/2a/2b/2c established, pins the rules that
must be fixed while writing (each with a recommendation, so the chunk is not
blocked; rule 2 revises the letter of two landed sentences and is flagged as
such), maps the rewrite surface onto `spec-v2/docs/`, and states the
hand-offs. 2d is written after 2c, so this chunk executes the
[`plan.md`](plan.md) note: it reconciles the co-owned `functions.md`
value-shape and hashing/printing text against 2c's capture record.

## The adopted changes, restated precisely

One chunk because one text: both changes rewrite the same
`functions.md`/`type-syntax-spec.md` sections, and the alignment rules the
`$sig` removal deletes are the same rules the `$fields` collapse would
otherwise force a rewrite of.

**The `$fields` lowering.** The canonical calling convention shrinks to
positional slots plus rest. An object-pattern parameter becomes shorthand
sugar: a parse-time desugaring into a plain required positional slot with a
synthesized name (rule 1) plus a **body-top eager `$let` of strict-read
projections**, one binding per field, with the printer folding the parameter
shape back — the `do` precedent Proposal 6 cites. Per field, where `p` is
the synthesized parameter:

- required `f` → `{ "$get": "f", "$from": {"$var": p} }` — a bare read;
  a miss is 2b's error;
- optional `f?` → the same read with `"$else": null` — absence binds `null`;
- defaulted `f = e` → the same read with `"$else": e` — the arm evaluates
  on absence only (rule 2).

The lowering is deliberately the **flat image of the future pattern
lowering** ([`type-eval-coherence.md`](type-eval-coherence.md) §1 piece 2):
parameter unification later *extends* this surface — nested and renamed
patterns arriving with the dialect — rather than re-lowering it, and no
pattern-bind kernel node is introduced yet.

**The `$sig` inlining.** `$sig` is removed from function bodies. Types
attach per slot — `$type` on the parameter descriptor — and the return type
moves to a **`$returns` sibling of `$return`** on the body. Inline types are
static syntax exactly as `$sig` was: the evaluator never consults them
(runtime argument/result validation remains the `$runtimeContract` wrapper
and contract edges), and they charge no fuel (rule 6). The
`required`/`optional`/`rest`/`returns` callable shape survives untouched as
the **interface description** — contract `functions`, contract `entry`, the
builtin registry, `$fnType` — with a normative derivation function from the
inline form (rule 4). "Fully typed or bare" becomes a per-body lint
(rule 5); contextually typed bare lambdas are untouched.

Deleted by the pair: the `$fields` descriptor grammar and its prohibitions
list; the Parameter-alignment zip rules in `type-syntax-spec.md` — and with
them the whole misalignment error class, impossible by construction once the
type lives on the slot; the object-pattern contract alignment rules (they
become consequences of ordinary read checking — rule 5); the dedicated
pattern-argument validation error class (its replacement identity is pinned
in the 2b hand-off below).

Untouched, stated to keep the boundary visible: the environment-contract
format and the builtin registry, byte for byte (the signature-shape axis
stays gated on its own contract revision — [`status.md`](status.md));
positional parameter semantics, including lazy `$default` and
omission-binds-`null`; the shorthand authoring surface, except the two
documented deltas in rule 2.

### Worked example

```jfn
route: ({ from, via?, weight = 1 }: Leg, scale: integer = 10) -> integer
  => ...
```

lowers to:

```json
{
  "$params": [
    { "$param": "__p0", "$type": { "$ref": "#/$defs/Leg" } },
    { "$param": "scale", "$default": 10, "$type": { "type": "integer" } }
  ],
  "$returns": { "type": "integer" },
  "$return": {
    "$let": {
      "from": { "$get": "from", "$from": { "$var": "__p0" } },
      "via": { "$get": "via", "$from": { "$var": "__p0" }, "$else": null },
      "weight": { "$get": "weight", "$from": { "$var": "__p0" }, "$else": 1 }
    },
    "$in": "..."
  }
}
```

and the interface derivation (rule 4) yields
`{ "required": [{"$ref": "#/$defs/Leg"}], "optional": [{"type": "integer"}],
"returns": {"type": "integer"} }` — the shape the contract entry check and
`$fnType` compatibility consume, unchanged from today's `$sig`.

## Rules to pin while writing

### 1. The synthesized parameter name

The lowering needs a name for the pattern's one object argument — the gensym
the `do` sugar never needed. Recommend **`__p<i>`**, where `<i>` is the
slot's zero-based index in `$params`, with the identifier space **reserved
in shorthand**: an identifier matching `__p` followed by digits is not a
valid shorthand identifier anywhere (binder or reference) — one grammar
sentence, precedent the reserved `effects` binding. Consequences:

- deterministic and local: the name depends only on slot position, so it is
  stable under body edits and changes only when the parameter list does;
- fold-back is unambiguous: a `__p<i>` in canonical JSON is lowering output
  or indistinguishable from it (rule 7's conditions still apply);
- canonical JSON may of course contain the names — the lowering emits them;
  hand-written canonical form using the scheme is given a meaning by the
  ordinary rules rather than policed, the `$captures` posture.

Rejected alternative: a collision-avoiding gensym (extend the name until
free) — deterministic but makes canonical shapes depend on distant name
choices; the reservation is cheaper and total. Multiple pattern slots lower
into **one** body-top `$let` (parameter order, then field order); field
names cannot collide across patterns (rule 3's surface uniqueness).

### 2. Defaulted fields lower to the `$else` arm; laziness narrows

The adopted texts left one seam: [`plan.md`](plan.md)'s lowering names bare
and optional binders only, while the 2a text kept "field defaults stay lazy
at the slot descriptor" — a descriptor this chunk deletes, and 2a's hand-off
simultaneously forbids a lazy form in the lowered `$let`. The chunk must
settle it. Recommend: **field `= e` survives as surface and lowers to the
projection's `$else` arm** (`?? e` at the access site). What is preserved is
exact: the arm fires on absence only, so a present `null` binds `null` and
suppresses the default — 2b's miss-only rule *is* today's suppression rule —
and the local type is `T | typeof(e)`, collapsing when subsumed, which is
today's `T` for a well-typed default. Two honest deltas, both to document:

- **Timing.** The default evaluates at bind time on absence — body-top,
  dependency-ordered — not lazily on first read. An absent field whose
  default errors now fails even when the binding is never read: the same
  accepted class of break as 2a's strict bindings, and the same fix (move
  work into the branch that needs it). The language ends the stage with
  exactly **one lazy construct**: the positional `$default`.
- **Cross-references.** Field defaults may reference parameters and sibling
  fields — now ordinary dependency edges, so mutual references between field
  defaults become static cycle errors even when both fields are supplied
  (today they fail only when read). Positional defaults may **no longer
  reference pattern fields**: the fields are `$let` bindings inside
  `$return`, outside the invocation scope defaults use. Recommend deleting
  that cross-reference outright (it is obscure: one parameter's default
  reading another parameter's destructured field). Fallback if the 2g corpus
  audit or a blind-authoring run shows real use: the lowering re-projects
  field references inside default expressions (deterministic, and printable
  because the reserved name cannot be authored) — an additive lowering rule,
  no format break.

Why not the alternatives: deleting field defaults entirely kills the good
defaulting idiom 2b's decision 2 leans on and manufactures exactly the
null-defaulting boilerplate its revisit criterion watches for; keeping them
lazy requires either a lazy form in the lowered `$let` (which 2a forbids) or
retaining `$fields` in canonical form for the defaulted case (which defeats
the collapse). This pin revises the letter of two landed sentences — the
`functions.md` lazy-exception framing and the runtime default-force
attachment ("`$default` on positional and `$fields` slots") — plus
[`strict-let.md`](strict-let.md)'s "(2d keeps the latter primitive)"
parenthetical. All are in this chunk's rewrite surface; the attachment
narrowing is a vocabulary redefinition inside Stage 2's single break, the
same posture as 2a's binding-force removal. [`plan.md`](plan.md)'s "defaults
stay lazy and primitive" remains true of the positional construct — the one
the sentence was protecting from Proposal 6's desugaring.

### 3. The slot grammar after the collapse

- A `$params` slot is a name string, a rest string (`"...rest"`), or a
  descriptor `{ "$param": name, ... }` with optional keys `$optional: true`,
  `$default: expression`, and `$type: schema` — closed, `$optional` and
  `$default` mutually exclusive, and **at least one of the three present**
  (a descriptor carrying only `$param` is invalid: one canonical spelling
  per layout). A rest slot in descriptor form carries the `...` prefix
  inside `$param` and admits only `$type`. `$fields` is invalid — the
  format break.
- `$returns` is an optional sibling of `$return` on any function body,
  schema-valued. Schema payloads under `$type`/`$returns` are validated
  structurally wherever function-body shape is validated — source, and
  hydrated values including open-body capture entries (2c rule 5's
  body-shape check covers it; no new boundary rule).
- Name uniqueness across one parameter list (positionals × fields × rest)
  becomes a **shorthand parse rule**. Canonically the projections are
  ordinary `$let` bindings: duplicates within one pattern are impossible
  (object keys), and a field name shadowing a positional parameter is the
  ordinary `$let` shadowing rule on a program the parser will simply never
  emit.
- The pattern surface keeps its existing parse rules: non-empty, identifier
  fields, no renames, no nesting, no whole-pattern `?`/`=`, `?` and `=`
  mutually exclusive per field.

### 4. The interface derivation

One normative function from the inline form to the callable shape, stated
once and consumed everywhere the shape is:

- `required` — the `$type` of each leading required slot in order (`true`
  when untyped); a lowered pattern slot contributes its `$type`, the object
  schema — exactly the schema today's alignment rules routed into
  `$sig.required`;
- `optional` — the `$type` of each `$optional`/`$default` slot in source
  order (`true` when untyped); function types continue not to distinguish
  the two;
- `rest` — present iff a rest slot is; the **element** schema, taken as
  `items` of the slot's array-shaped `$type` (`true` when untyped; rule 8
  pins the array-as-written encoding);
- `returns` — `$returns`, or `true` when absent; a `$taskType` result
  satisfies a contract-entry `{"task": A}` by the evident mapping (one
  sentence).

Consumers: the contract-entry satisfaction check ("the selected module
function must satisfy the entry" consumes the derivation — the
`environment-contract.md` sentence currently says "even when the module has
its own `$sig`"); `$fnType` compatibility for function values and
references (counts from `$params`, schemas from `$type`); the builtin
registry's concrete-function-value rule; and the checker's own check of a
named function's body against its declared types. The derivation is one-way
— nothing ever reconstructs a pattern from the interface shape, which is
what dissolves "an object pattern consumes one slot; its fields consume
none" into a triviality.

### 5. Checker surface: alignment becomes reading; fully-typed becomes a lint

- Per-slot rules restated where the alignment section died: `$type`
  validates a **supplied argument**; the local type of a plain optional
  parameter is `T | null` and of a defaulted parameter is `T`; explicit
  `null` must be admitted by `T`; a default expression is checked against
  `T` even if unused.
- The pattern-contract rules become **derived consequences** of 2b's read
  checking against the synthesized slot's `$type`: a required field over an
  optional property is 2b's optional-field bare-read error (the old "an
  optional property cannot back a required field", now derived, with a
  better message); an optional field types as `T | null` via `$else` union
  typing; a defaulted field as `T | typeof(e)` collapsing. One deliberate
  loosening: a defaulted field over a *required* property was an alignment
  error ("the default is unreachable") and becomes a silently dead arm —
  recommend an unreachable-`$else` diagnostic as a lint-level follow-up
  shared with all `??` sites (the posture of 2b's dead-`!` warning), not
  normative 2d text.
- **Fully typed or bare** stops being structural: the parser accepts partial
  annotations (the "annotations are all-or-nothing" sentences delete — also
  required for printer totality, rule 7), annotations present on a partially
  annotated body are used as declared, and a named (module or reachable
  local) function that is not fully annotated receives the existing
  missing-signature treatment — error under full-coverage policy, info under
  `allowUntypedFunctions`. Contextually typed bare lambdas are untouched; an
  annotated lambda remains a concrete function value (the registry text
  rewords "`$sig`-annotated" accordingly).

### 6. Cost

- **Annotations charge nothing.** `$type` and `$returns` payloads contribute
  zero to region constants — like object keys, not like data literals: they
  are static syntax that never produces a value. The normative sentence
  [`plan.md`](plan.md) asks for lands here: **typing a function cannot
  change its fuel.** The zero count is forced, not chosen: checking must be
  erasable (2f) and fuel is observable, so annotations must be
  fuel-invisible. One sentence distinguishes `$as`'s `$type` — a declared
  runtime position whose validation cost is unchanged and out of scope.
- The lowered projections charge as what they are: `$let` and `$get` nodes
  in their region's static constant; optional and defaulted fields are
  branch points whose `$else` arm is a region entered by **arm selection**
  on a genuine miss — 2b's rule verbatim, no new text. Cost deltas against
  the old `$fields`, priced into the break: an absent optional field now
  fires an arm-selection event; a defaulted field no longer fires
  default-force.
- The **default-force event attachment narrows to the positional
  `$default`** — the vocabulary-redefinition note mirrors 2a/2b/2c's.
- Conformance vector to draft for 2g: one program, annotated and bare,
  consumes identical fuel.

### 7. Printing and fold-back

- Annotations print back to `(name: T)` / `-> R` through the existing
  schema-to-type-syntax rendering; a partially annotated body prints
  partially (rule 5 made the surface accept it).
- The pattern folds back exactly when all of: the slot name matches the
  reserved scheme at its own index; `$return` is a `$let` every one of whose
  bindings is a projection from a pattern slot's variable with `$get` key
  equal to the binding name (bare / `$else: null` / `$else: e` printing as
  `f` / `f?` / `f = e`), the slot's `$type` printing as the pattern's
  annotation; and the synthesized variable appears nowhere else — any other
  reference, reordering, or extra binding prints the explicit canonical form
  instead. No fold is never an error; `parse(print(node)) = normalize(node)`
  holds on both paths.
- The normalizer needs **no new rule**: `$sig` and `$fields` are invalid
  input rather than normalizable spellings, and the desugaring is
  parser-side, exactly like `do`.

### 8. Small calls

- **Rest `$type` stores the array type as written** (`...rest: string[]` →
  `{"type": "array", "items": {"type": "string"}}` on the slot), with the
  validity rule that it be an array schema without `prefixItems`; the
  derivation takes `items`. Storing the element schema inline would
  reproduce in miniature the surface/artifact mismatch this chunk exists to
  delete; the conversion lives in the one derivation function instead.
- `$comment` stays invalid inside slot descriptors (closed shapes); the
  body-level `$comment` rule is unchanged.
- `arity` text survives as "every non-rest slot counts once"; the
  "including object patterns" clause deletes with the construct.

## Rewrite surface, file by file

Normative core:

- `spec-v2/docs/language/json/functions.md` — the primary rewrite: the
  source-field list (`$sig` out, `$returns` in) stated **once** as the
  post-Stage-2 field list, reconciling 2c's co-owned text — source body:
  `$return`, `$params`, `$returns`, `$comment`; evaluated values add
  `$captures`, `$runtimeContract`. The Parameters section gets the slot
  grammar (rule 3), per-slot `$type` with the per-slot typing rules
  (rule 5), and the lazy-default exception narrowed to the positional
  `$default` (rule 2). The Object-pattern section is rewritten from a
  canonical construct to the lowering: the sugar statement, the per-field
  table, the reconciling sentence 2b's hand-off assigned here (after the
  lowering, the parameter surface's absence→`null` convention and the
  access site's absence→error/arm convention are **one mechanism**: an
  optional field *is* `?? null`, a defaulted field *is* `?? e`, projected at
  body top), the flat-image forward commitment, and rule 2's authoring
  deltas.
- `spec-v2/docs/language/shorthand/type-syntax-spec.md` — the Function
  signatures section relowers to `$type`/`$returns` with the worked example;
  the **Parameter alignment section is deleted**; the Object-pattern
  contracts section is rewritten to the derived-consequence story (the
  annotation attaches to the synthesized slot; the alignment bullets restate
  as checker consequences); the all-or-nothing sentences delete (rule 5);
  the Rejected-syntax list drops "partial function signatures" and keeps the
  pattern-surface exclusions.
- `spec-v2/docs/language/json/expressions.md` — the Function-body section
  and the constraints list: `$sig` out, `$returns` in, descriptor keys
  named; the checker bullet "a reachable named function must declare a
  complete signature" rewords to the lint posture (rule 5).
- `spec-v2/docs/deployment/environment-contract.md` — the entry sentence
  ("even when the module has its own `$sig`") rewords to consume the
  derivation (rule 4). Nothing else: the format is untouched.
- `spec-v2/docs/builtins/builtin-signatures.md` — the three
  "`$sig`-annotated" sites reword to fully-annotated/inline; the
  contextual-callback rules are otherwise unchanged, as is the registry
  format.
- `spec-v2/docs/language/json/modules.md` — the example's `$sig` becomes
  `$returns`; verify the resolution text needs nothing (projections are
  ordinary `$let` bindings).
- `spec-v2/docs/language/json/closures.md` — the open-body entry
  parenthetical gains `$returns` and typed descriptors (the edit 2c
  scheduled for 2d); verify the capture relation needs nothing — the
  free-variable relation already sees projections as ordinary bindings.
- `spec-v2/docs/language/json/execution-limits.md` — one paragraph beside
  the closure-cost one: annotations charge nothing (typing cannot change
  fuel); projections charge as `$let`/`$get`, the `$else` arm by arm
  selection on a miss (rule 6).
- `spec-v2/docs/runtime/execution-limits.md` — the default-force bullet
  narrows ("an omitted parameter's or field's `$default`" → the positional
  `$default`); the boundary sentence in Static regions loses its `$fields`
  mention; the versioning note gains the mirroring sentence (redefinition
  priced into the Stage 2 break).

Consistency sweep:

- `spec-v2/docs/language/shorthand/function-literals-and-local-bindings.md`
  — the Parameters and Object-pattern sections keep their surface text; the
  canonical lowerings shown are updated to the projection form; the
  defaults-scope paragraph takes rule 2's deltas; the named-function typing
  sentences align with the lint posture.
- `spec-v2/docs/language/shorthand/grammar.md` — the reserved-identifier
  sentence (rule 1); the param productions are unchanged (surface is
  preserved); the pointer note to type syntax survives.
- `spec-v2/docs/language/json/standard-library.md` — the "`$sig`-annotated
  callbacks" line rewords.
- `spec-v2/docs/conformance/checking.md` — verify-only: the
  `allowUntypedFunctions` description reads correctly against rule 5.
- `spec-v2/docs/language/json/index.md` — the `functions.md` line's
  "signatures" wording.
- `spec-v2/docs/language/json/tasks-and-effects.md` — verify-only: suspended
  bodies carry `$returns` automatically (2c preserves bodies byte-for-byte);
  the total-handler annotation is a different position and untouched.
- `spec-v2/docs/guides/writing-jfn.md` — §6: the surface examples survive;
  two trip-up lines land (field defaults run at call time on absence; a
  positional default cannot read a destructured field); the fully-typed
  teaching survives with the lint framing; the §13 lists touch accordingly.

## Hand-offs to sibling chunks

- **2a (strict `$let`)** — consumed: the projections are ordinary strict
  bindings; dependency order, cycle identity, and the TDZ rule apply
  verbatim, which is why the lowering needs no rules of its own. Rule 2
  supersedes [`strict-let.md`](strict-let.md)'s "(2d keeps the latter
  primitive)" parenthetical; the two landed spec sentences it produced are
  in this chunk's rewrite surface, so the two texts keep telling one story.
- **2b (strict reads)** — consumed: the lowering targets `$get`/`$else`
  exactly as its hand-off anticipated, `$else: null` typing included; the
  requested reconciling sentence for the two absence conventions lands in
  `functions.md`. Nothing here restricts `$else` arms to
  shorthand-expressible positions. The object requirement of patterns is
  enforced *by* 2b's rules: key-kind rejection and non-container traversal
  are errors, not misses, so `$else` arms never swallow a non-object
  argument — the error identity changes from the dedicated pattern error to
  2b's access errors (named in the text as a format-visible identity
  change).
- **2c (capture closures)** — this chunk executes the reconciliation: the
  one field list in `functions.md`, `$returns` in the open-body entry rule,
  and the hash-vector list extended (typed body, `$returns`, lowered
  pattern, open-body entry carrying both). Captured fields are captured
  projection values — ordinary binding values, no new capture text.
- **2e (boolean conditions)** — no interaction: the lowering emits no
  conditions, and no new 2d text may lean on truthiness.
- **2f (coherence framing)** — consumes rule 5 and rule 6 as instances of
  the invariant (alignment-as-reading; types are fuel- and
  evaluator-invisible outside declared runtime positions); written after 2d
  so it states, rather than anticipates, this text.
- **2g (conformance assembly)** inherits the case consequences; drafted
  here, assembled there:
  - delete: `$sig` parse/check fixtures as authored; `$fields` parse/eval
    suites in their descriptor form; alignment-error cases (the class is
    unexpressible);
  - rewrite: pattern parse/eval cases to the lowered canonical shapes;
    signature check suites to per-slot `$type`/`$returns`;
  - add: derivation cases (entry satisfaction, `$fnType` value
    compatibility, task-entry mapping); per-slot typing and the
    fully-typed lint under both policies; fold-back round-trips including
    deliberate no-fold cases (extra binding, reordered projections, foreign
    reference to the synthesized name); the raw-inference matrix row
    (schema payloads under `$params`/`$returns` are never wrapped); cost
    vectors (annotation fuel-invariance; optional-field miss arm selection;
    narrowed default-force; field-default-at-bind-time); error-identity
    cases (non-object pattern argument through the projection; required
    field miss naming the key; field-default cycle as a static cycle
    error); hash vectors per rule 7/2c.
  - The `examples/` corpus audit rides 2g: patterns are common, and the
    migration should be invisible except rule 2's deltas — the outcome
    feeds rule 2's fallback criterion.
- **Stage 3 (Proposal 7 audit)** — inherits a smaller surface: the
  alignment rules and the signature-shape matching text are gone; the audit
  runs against slots plus the one derivation function.
- **Post-Stage-5 (pattern dialect, parameter unification)** — the forward
  commitments land normatively here: `$type` is the shared attachment key
  (the dialect's typed binder uses the same shape); the lowering is the
  flat image parameter unification extends, never re-lowers; pattern-level
  defaults stay excluded from the dialect while field `= e` remains
  parameter-surface sugar folding to the `$else` arm.
- **[`status.md`](status.md)** — record rule 2's settlement (and its
  fallback criterion) when the spec text lands, as 2b's decisions were; the
  Proposal 6 signature-shape entry is unaffected and its wording ("the
  callable shape survives as the interface description, with a normative
  derivation") is confirmed by rule 4.

## Acceptance criteria

- No `$sig` and no `$fields` anywhere in canonical form; the Parameter
  alignment section is deleted, not rewritten; the misalignment error class
  cannot be expressed, and a conformance case asserts the shapes are
  rejected.
- Every typing rule the old pattern-contract text stated is **derived** from
  2b's read checking on the lowered form; no bespoke pattern checker text
  remains.
- Typing is fuel-invisible and evaluator-invisible outside declared runtime
  positions: one program, annotated and bare, evaluates identically and
  consumes identical fuel, and a conformance vector asserts it.
- The interface artifacts — contract format, builtin registry — are
  byte-unchanged, and every consumer of the callable shape goes through the
  one derivation function.
- Exactly one lazy construct remains: the positional `$default`, the only
  attachment of the default-force event.
- The shorthand surface is unchanged except rule 2's two documented deltas;
  the pattern and annotation fold-backs round-trip under
  `parse(print(node)) = normalize(node)`.

Format-visible changes originating here: `$sig` and `$fields` become invalid;
`$type` on slot descriptors and `$returns` on bodies; synthesized `__p<i>`
slots and the lowered projection `$let` in canonical form; the narrowed
default-force attachment and the pattern-error identity change. All priced
into Stage 2's single break; printer/normalizer rule assembly and vector
pinning stay with 2g, as for the whole stage.
