# json-fn Shorthand Specification

A compact, code-first surface syntax for authoring json-fn programs. The
**canonical form is JSON** — the interpreter only ever sees JSON. Shorthand
lowers deterministically to canonical json-fn JSON, and canonical JSON
pretty-prints back to shorthand.

- **Semantics-preserving.** Shorthand is correct only if it lowers to exactly
  the JSON you would have hand-written.
- **Code-first.** Identifiers and calls are code by default; literal strings are
  quoted; quoted data needs no keyword — the parser infers the canonical `$raw`
  boundary from [static JSON](literals-and-data.md).
- **Bijective (by normal form).** One canonical shorthand per normalized JSON
  node and vice versa: `parse(print(node)) = normalize(node)`. Byte-exact
  round-tripping of arbitrary hand-written JSON is _not_ guaranteed — JSON is
  normalized to canonical form first (e.g. [property-access spellings](variables-and-property-access.md);
  redundant [`$raw` wrappers](literals-and-data.md)).

File extension: `.jfn`.

---


## Contents

- [1. Lexical structure](lexical-structure.md)
- [2. Expressions overview](expressions.md)
- [3. Literals and data](literals-and-data.md)
- [4. Function calls and references](function-calls-and-references.md)
- [5. Variables and property access](variables-and-property-access.md)
- [6. Operators and precedence](operators-and-precedence.md)
- [7. Control flow](control-flow.md)
- [8. Function literals and local bindings](function-literals-and-local-bindings.md)
- [9. Files and program shape](files-and-program-shape.md)
- [10. Grammar (informal EBNF)](grammar.md)
- [11. Truthiness](truthiness.md)
- [12. Open decisions (tracked)](open-decisions.md)
- [13. Effects: `do` and `handle`](effects.md)
- [Type syntax](type-syntax-spec.md)
