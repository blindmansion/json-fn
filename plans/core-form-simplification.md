# Core-form simplification (deprecate JSON-authoring conveniences)

Status: **design sketch**, nothing implemented.

Several core forms exist only to make **hand-authored JSON** terser or more
flexible. Now that the shorthand is the authored surface, that redundancy is
dead weight: the shorthand can lower to a smaller, more orthogonal core, and we
can strip the concise-but-overlapping node forms from the interpreters. Each
removal is a breaking change to the JSON layer, so batch and sequence them; the
shorthand output changes in lockstep.

## Candidates

- **Drop first-class comparator nodes in favor of stdlib functions.** The
  language has both `$eq`/`$neq`/`$lt`/`$lte`/`$gt`/`$gte` nodes **and** stdlib
  `eq`/`neq`/`lt`/`lte`/`gt`/`gte` functions (`docs/language.md` "Comparison").
  The shorthand could lower `==`/`<`/… to named calls (exactly as `+`→`add`),
  letting us remove the special-cased comparison nodes from all four evaluators.
- **General principle:** audit every `$`-form that duplicates a stdlib call or
  adds an authoring shortcut, and prefer the smaller orthogonal core.

## Keep

**Keep** forms whose semantics are _not_ otherwise expressible: short-circuit
`$and`/`$or` (distinct from the eager stdlib `and`/`or`), the lazy-branch
control forms (`$if`/`$cond`/`$match`), and `$raw`. This is a simplification of
redundant sugar, not a push to make everything a function call.
