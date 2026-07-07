# Core-form simplification (deprecate JSON-authoring conveniences)

Status: **design sketch**, nothing implemented.

Several core forms exist only to make **hand-authored JSON** terser or more
flexible. Now that the shorthand is the authored surface, that redundancy is
dead weight: the shorthand can lower to a smaller, more orthogonal core, and we
can strip the concise-but-overlapping node forms from the interpreters. Each
removal is a breaking change to the JSON layer, so batch and sequence them; the
shorthand output changes in lockstep.

## Candidates

- **Collapse property access onto `$get`/`$from` only.** Today access has three
  spellings: `$var`'s embedded dotted path-string (`{"$var":"a.b[0]"}`), the
  `$var`+`$get` combo, and the orthogonal `$get`/`$from` form. Keep bare `$var`
  for a plain variable reference and route **all** path/index access through
  `$get`/`$from` (cleaner, one way to compose, no string-path parsing in the
  evaluator). This revisits the current canonical choice in
  `docs/shorthand-spec.md` §5 (which today canonicalizes to `$var`/`$get`) and
  supersedes the narrower "dotted path-string" deprecation already noted there.
- **Drop first-class comparator nodes in favor of stdlib functions.** The
  language has both `$eq`/`$neq`/`$lt`/`$lte`/`$gt`/`$gte` nodes **and** stdlib
  `eq`/`neq`/`lt`/`lte`/`gt`/`gte` functions (`docs/language.md` "Comparison").
  The shorthand could lower `==`/`<`/… to named calls (exactly as `+`→`add`),
  letting us remove the special-cased comparison nodes from all four evaluators.
- **Split the call/reference `$fn` form.** Today `$fn` is one key overloaded by
  the *shape* of its value: an array (`{"$fn":["add",3,4]}`) is a call, a
  non-array (`{"$fn":"add"}`) is a reference. That was chosen for terse authored
  JSON, but it packs two different concepts (call-vs-reference, and callee-vs-args)
  into a value-shape test, so every pass re-derives them via `Array.isArray` /
  positional `[0]` vs `[1..]` slicing (see the `idx === 0` special-case in
  `replaceVars`, and `evaluateFunctionCall`). It also makes a one-bracket footgun
  (`["f"]` zero-arg call vs `"f"` reference) and smears validity across array
  length. Restructuring so node-kind and head/args live on **keys/fields** makes
  the evaluator and the eventual checker dispatch by key like every other node,
  and aligns syntactic kind with semantic kind (a reference's type is a `$fnType`;
  a call's type is the callee's return). Two directions:
  - **Old `{ $fn, $args? }` form.** Callee always in `$fn`; `$args` present ⇒
    call (even `[]`), absent ⇒ reference. Buys the field-based head/args split
    and kills the positional/`Array.isArray` logic. This is the form the language
    had before it was made array-concise.
  - **Fully split `$call` / `$fn`.** A call is `{ "$call": <callee>, "$args": [...] }`;
    a reference is `{ "$fn": <callee> }`. Additionally makes call-vs-reference a
    *key* (one node kind per key), so the checker's `switch (nodeKind)` never
    branches on "does `$args` exist." Cleanest for tooling; costs one more key in
    the vocabulary.
  Both remove the array-shape discrimination; the full split additionally removes
  the presence-of-`$args` discriminant.
- **General principle:** audit every `$`-form that duplicates a stdlib call or
  adds an authoring shortcut, and prefer the smaller orthogonal core.

## Keep

**Keep** forms whose semantics are *not* otherwise expressible: short-circuit
`$and`/`$or` (distinct from the eager stdlib `and`/`or`), the lazy-branch
control forms (`$if`/`$cond`/`$match`), and `$raw`. This is a simplification of
redundant sugar, not a push to make everything a function call.
