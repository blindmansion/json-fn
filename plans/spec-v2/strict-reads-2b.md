# Plan: strict reads (Stage 2 chunk 2b)

Status: **spec text written**, 2026-08-08 — the rewrite surface below has
landed in `spec-v2/docs/`; the conformance-case consequences remain with 2g.
The decisions this chunk owns are settled as recommended (recorded in
[`status.md`](status.md)). Owns [`plan.md`](plan.md) Stage 2 chunk 2b.
The design itself is settled — [`strict-reads.md`](strict-reads.md) as revised
2026-08-04, absorbed per [`review.md`](review.md) (Proposal 10 resolves
there). That document predates Stage 1 and chunk 2a, so this document restates
the design in the spec-v2 vocabulary (event-trace cost model, strict
bindings), settles the decisions [`status.md`](status.md) routes to this
chunk (the `??` spelling and the null-defaulting surface), pins the small
rules that must be fixed while writing, and maps the rewrite surface onto
`spec-v2/docs/`.

## The adopted design, restated precisely

Two changes to the access node, landing together:

**Single-key `$get`.** An evaluated `$get` key must be one string (object
property) or one integer (array element / string code point); any other
evaluated key is an immediate error. The array-path form is deleted from the
canonical language: `a.b[0].c` lowers to nested `$get`s, one per segment, and
the printer folds nested static `$get`s back to the dotted/indexed path. The
evaluator never dispatches on the shape of an evaluated key beyond
string-vs-integer validity — the last place where runtime data shape selected
the operation.

**Absence policy at the access site.** A **bare** `$get` miss — missing
object key, out-of-range or negative index — is an immediate error: absence
is a bug. An optional **`$else` arm** carries the other policy: on a genuine
miss the arm evaluates and supplies the value; absence is a case.

```json
{ "$get": "sku-42", "$from": { "$var": "inv" } }
{ "$get": "sku-42", "$from": { "$var": "inv" }, "$else": { "$var": "empty" } }
```

Pinned by absorption (not reopened here):

- `$else` fires on **absence only**, never on a present `null` value. This is
  Proposal 10's resolution: bare reads and `$else` arms both preserve the
  absent / present-and-null distinction.
- The arm evaluates only on a miss, like the `$else` arms of `$if`, `$cond`,
  and `$match`.
- Reading *through* a present `null` errors, as does accessing a
  non-container; keys are never coerced. Unchanged from today.
- **No new builtins**: `?? null` is the nullable lookup, `?? d` the defaulted
  one; the once-proposed `lookup`/`get` builtins stay cancelled.
- Miss errors are **host errors** — the same class as `checked as` failures
  and arithmetic errors, not `raise`-catchable domain signals.
- A bare read of a field declared `k?: T` is a **checker error** ("this field
  may be absent; add `?? default` or guard with `hasKey`"); `hasKey`
  narrowing lands in this chunk so guard-style access typechecks. The runtime
  rule for such a read is the same as every bare `$get` — a miss errors — so
  the checker rule makes the runtime path near-unreachable rather than being
  the enforcement mechanism.
- `!` reverts to its narrow job: stripping `null` from types that include it.
- Writes, merges, and spreads are unchanged; only reads change.

Decision procedure to teach: *absence is a bug → bare access; absence is a
case → `?? default`.*

## Decisions this chunk owns

These are the two [`status.md`](status.md) residues routed here, plus two
small calls the source plan left open. Each gets a recommendation so the
chunk is not blocked; the first two should be recorded as settled when the
spec text lands.

### 1. The `??` spelling — keep it, miss-only, access-only

Recommend **`??`**, meaning exactly the `$else` arm: it fires on absence,
never on a present `null`. The left operand must be a property or index
access; `expr ?? d` on anything else is a parse-time error naming the rule.

The JS prior (null-coalescing) is the objection, and two things defuse it:

- **The checker keeps the residue visible.** `x[k] ?? d` types as
  `T | typeof(d)`, collapsing when subsumed. When the element type includes
  `null`, a present `null` passes through the default and *stays in the
  type*, so code that assumed JS semantics gets a loud type error at the
  first non-null use — not a silently wrong value. The trip-up is
  checker-caught, which is the standard this language holds elsewhere.
- The main alternative, `?:`, carries the same prior conflict (Elvis is
  null-coalescing in Kotlin/Groovy) *and* collides visually with the
  optional-field token sequence in type syntax (`score?: integer`). No
  spelling is prior-free; `??` at least reads as "or else" and its
  divergence from JS is one documented sentence.

The guide gets the trip-up prominently: unlike JS, `??` here fires on
*absence*, not on a present `null`.

### 2. The null-defaulting surface — no dedicated form

D4 (chunk 2e) deletes truthiness, killing the `x || default` idiom.
Absence-defaulting is this chunk's `$else`; the question is what replaces
null-defaulting. Recommend **nothing in Stage 2** — the explicit conditional
is the idiom:

- **It is fully typed.** `x != null` / `isNull(x)` narrowing is already
  exact (`T | null` ⇒ `T`), so `if isNull(h) then d else h` needs no
  assertion and no new machinery. D4 makes condition narrowing exact
  everywhere else, so this only gets better.
- **The main null producers have better fixes.** Plain optional parameters
  bind `null` on omission — the defaulting author should write a lazy
  parameter default (`= expr`) instead of coalescing in the body. What
  remains is nullable stdlib returns (`head`, `last`, `find`), a real but
  narrower surface.
- **Deferring is additive; the `$else` arm is not.** A null-defaulting
  operator or builtin can land later without a format break — it is surface
  plus at most one builtin. The `$else` arm changes the canonical node and
  must ride Stage 2's single break. Committing the format-breaking piece now
  and holding the additive piece is the cheap posture.
- **Two adjacent defaulting operators is the confusion we are avoiding.** A
  null-coalescing operator sitting next to miss-only `??` forces every
  author to hold the absence/null distinction at every defaulting site;
  one form with one rule does not.

Record in [`status.md`](status.md) as resolved-for-Stage-2 with the revisit
criterion: if the 2g corpus migration or the next blind-authoring run shows
pervasive `if isNull(…)` boilerplate around stdlib nullable returns, a
dedicated form (spelled distinctly from `??`) is the additive follow-up.

### 3. `??` precedence, associativity, chaining

Recommend a new row between additive and comparison in the shorthand
precedence table — looser than `+ - ++`, tighter than the comparison chain —
**right-associative**:

- `a[i] ?? b + 1` parses as `a[i] ?? (b + 1)`: a default is usually a small
  computed value.
- `x.k ?? limit < 9000` parses as `(x.k ?? limit) < 9000`: default, then
  compare.
- `a[i] ?? b[j] ?? d` parses as `a[i] ?? (b[j] ?? d)` and lowers to nested
  `$else` arms — the first miss falls to the next access, then to `d`.

The left-operand restriction (rule 1) is enforced at lowering, not by the
precedence grammar.

### 4. Two small calls

- **Tuple literal-index bounds**: adopt — a literal index beyond a tuple
  type's tracked arity (`pair[2]`) is a static error. Checker-only, cheap,
  and consistent with reads being as strict as their types.
- **The dead-`!` warning** (`e!` where `e : T` with no `null` arm): a
  lint-level follow-up, not normative 2b text. Same posture as 2d's
  "fully typed or bare" per-body lint.

## Rules to pin while writing

### 1. `$else` is a conditional arm, not laziness

Chunk 2a's text names lazy parameter defaults "the language's one documented
exception to strict evaluation" (`functions.md`). The `$else` arm must not
read as a second exception: it is **branch selection** — one of two arms, at
most one taken, exactly like `$if`'s — and branch arms were never part of
the strictness claim. Whether the arm evaluates is determined by a value
(the miss), so the determinism statement is untouched. One framing sentence
in `expressions.md` keeps the two texts from colliding.

### 2. Cost treatment

Patterned on the `$and`/`$or` operand rule:

- A bare `$get` is ordinary straight-line work: it counts in its containing
  region's static constant and fires no event.
- A `$get` with `$else` is a **branch point**. The target and key evaluate
  in the containing region; the `$else` arm is its own region, entered by
  the **arm-selection event** on a genuine miss. A hit fires no event and
  stays in the containing region.
- The arm-selection bullet in `runtime/execution-limits.md` gains the `$get`
  `$else` arm in its attachment list. As with 2a's binding-force removal,
  this is a **redefinition of the vocabulary inside Stage 2's single
  break**, not a versioned addition.
- Path unfolding changes node counts: `a.b[0].c` is three `$get` nodes where
  one node with an array key stood, so **region static constants change**
  for every program with a multi-segment static path. No new rule text —
  the region rule already counts nodes — but the affected cost vectors
  regenerate in 2g, priced into the same break.

### 3. Error identity

Pin the payloads the way 2a pinned the cycle rendering, in the property-access
section of `expressions.md`:

- object/map miss: names the key and, when the container is small, the
  available keys;
- array/string miss: names the index and the length (negative indices are
  the same error);
- invalid key: names the evaluated key's kind — "evaluated `$get` key must
  be a string or an integer";
- all three are host errors (see the pinned class above). Runtime source
  spans are not required.

### 4. Checker typing

- Bare `x[k]` / `x.k` types as the element/field type `T` — never `T | null`.
- The `$else` form types as `T | typeof(else-arm)`, collapsing when
  subsumed; `?? null` is therefore `T | null`, the nullable lookup.
- Bare read of a declared-optional field: the static error pinned above.
- Tuple literal indices: bounds-checked (decision 4).
- Map and open-object reads stay bare-allowed: the checker cannot prove
  presence, so these are the sites the decision procedure and the guide
  target with `??`.

### 5. `hasKey` narrowing

New form in `narrowing.md`, kept as small as the existing set:

- Subject shape: `hasKey(path, "lit")` — a narrowable field-path subject
  (same paths as discriminant narrowing) and a **literal** string key.
- then-branch: the optional field `k?: T` on the subject's type becomes
  present (`k: T`), so a bare read typechecks.
- else-branch: on a **closed** object type, the field is known absent
  (remove the optional field); on open objects and maps, no fact.
- No fact from non-literal keys or non-path subjects, matching the existing
  limits section.

## Rewrite surface, file by file

Normative core:

- `spec-v2/docs/language/json/expressions.md` — the Property-access section
  is the primary rewrite: the single-key rule and the deleted array-path
  form (examples updated to nested `$get`s), the `$else` arm with miss-only
  firing and the Proposal 10 absent-vs-null statement, error identities
  (rule 3), the arm-not-laziness framing sentence (rule 1), and a new
  checker paragraph (rule 4: `$else` union typing, the optional-field
  bare-read error). The constraints list changes from "`$get`/`$from` must
  be the only two keys" to: both required, optional `$else`, nothing else
  (plus the common `$comment` rule, which already names this form).
- `spec-v2/docs/language/json/narrowing.md` — the `hasKey` form (rule 5)
  joins the numbered narrowing forms; the limits section notes the
  literal-key restriction.
- `spec-v2/docs/language/json/execution-limits.md` — a short access-cost
  paragraph beside the `$let` one: bare `$get` is region work; the `$else`
  arm is a region entered by arm selection on a miss (rule 2).
- `spec-v2/docs/runtime/execution-limits.md` — the arm-selection event
  bullet gains the `$get` `$else` arm; the region rule's "branch point"
  already covers the rest. One sentence in the versioning note mirroring
  2a's: vocabulary redefinition priced into the Stage 2 break.

Consistency sweep:

- `spec-v2/docs/language/shorthand/function-calls-and-references.md` — the
  lowering rules lose static-run folding (every segment gets its own
  `$get`; the `a.b.c` and `a.b[0].c` examples become nested chains); the
  printer rule folds nested static `$get`s back to the dotted/indexed path
  (printback unchanged); method-callee lowering follows automatically; the
  `??` surface lowers to the `$else` arm.
- `spec-v2/docs/language/shorthand/operators-and-precedence.md` — the new
  `??` row (decision 3): position, right associativity, lowering, the
  access-only left operand, and the chained-defaults example.
- `spec-v2/docs/language/shorthand/grammar.md` — the `??` production and
  the access-suffix grammar it attaches to.
- `spec-v2/docs/language/shorthand/literals-and-data.md` — the pun aside's
  "`$get` path" wording aligns with nested chains; verify the spread /
  computed-key text does not mention paths.
- `spec-v2/docs/language/shorthand/type-syntax-spec.md` — verify-only:
  optional-parameter semantics (omission binds `null`) are the parameter
  surface, untouched here; nothing may conflate them with field-access
  absence.
- `spec-v2/docs/language/json/standard-library.md` — one audit note:
  partial accessors keep their honest nullable signatures (`head`, `last`,
  `find`) plus any strict non-empty overloads; nothing may promise
  null-on-miss for reads.
- `spec-v2/docs/guides/writing-jfn.md` — §9 rewrites around the new rule
  ("reads are as strict as their types"), teaching the decision procedure
  and `?? default` / `?? null`; the `balanceOf` example simplifies
  (`led[id] ?? …` or keep the `hasKey` guard to demonstrate narrowing —
  show both once); the "Missing keys read `null`" trip-up lines are deleted
  from §9 and the §13 lists; the JS-`??` trip-up (fires on absence, not on
  present `null`; the checker keeps the null residue in the type) is added
  prominently; the `!` guidance narrows to genuine `T | null` values. The
  truthiness lines (`emptyIsTruthy`, `fallback: value || "default"`) are
  2e's rewrite, not ours — but no new 2b text may lean on `||` defaulting.

## Hand-offs to sibling chunks

- **2d (`$fields` lowering)** targets exactly this chunk's forms: an
  optional pattern field lowers to a `$get`/`$else` projection with
  `$else: null`, so "`?? null` types as `T | null`" is the checker story
  the lowering inherits verbatim. Nothing in 2b's text may restrict `$else`
  arms to shorthand-expressible positions, and the parameter surface's
  absence→`null` convention (omitted optionals bind `null`) must stay
  clearly distinct from access-site absence (an error unless `$else` says
  otherwise) — the two conventions meet in 2d's lowering and the sentence
  that reconciles them lives there.
- **2e (boolean conditions)** consumes this chunk's defaulting story: its
  `x || default` migration text points at `?? default` for absence and the
  exact-narrowed conditional for null (decision 2). 2b lands first so 2e
  states, rather than anticipates, the replacement forms.
- **2c (capture closures)** has no semantic interaction; nested `$get`
  callee shapes appear in method-call examples both chunks print, and
  whichever is written second reconciles shared examples.
- **2g (conformance assembly)** inherits the case consequences; drafted
  here, assembled there:
  - delete: every null-on-miss property/path case; the array-path parse and
    eval cases;
  - rewrite: computed-key cases against the single-key rule (an evaluated
    array key now errors);
  - add: in-range reads and misses per container kind (array, string,
    object, map, tuple, closed object, optional field); `$else` laziness
    (arm not evaluated on a hit) and the miss-side arm-selection cost
    vector; `?? null` typing; the invalid-key error; a regression asserting
    the miss error fires at the access site inside a fold; region-constant
    vectors for path unfolding; `hasKey` narrowing and the optional-field
    bare-read checker error; the tuple literal-index bound.
  - The `examples/` corpus audit rides 2g: expect near-zero breakage
    (functional style routes element access through HOFs), and each
    null-on-miss reliance migrates mechanically to `?? default` or a
    `hasKey` guard — the corpus outcome feeds decision 2's revisit
    criterion.

## Acceptance criteria

Carried over from [`strict-reads.md`](strict-reads.md), rephrased for the
spec-v2 surface:

- Runtime absence behavior is derivable from canonical syntax alone; no
  checker-only information influences evaluation.
- No path walks exist at runtime; the evaluator's only key dispatch is
  string-vs-integer validity.
- Checker projection and runtime behavior agree for required, optional, map,
  array, tuple, closed/computed-object, and string reads.
- Absence-as-a-case is explicit at the access site, lazy, and typed as the
  union; `?? null` fully covers nullable lookup with no builtin.
- The cost story is complete: bare reads are region work, the `$else` arm is
  an arm-selection region, and path unfolding is priced into the Stage 2
  break's regenerated vectors.

No new format-visible shapes beyond the `$else` key itself and the unfolded
path chains — both priced into Stage 2's single break, with printback
(dotted paths, `??`) hiding both from shorthand authors. Hashing and printer
rule assembly stays with 2g, as for the whole stage.
