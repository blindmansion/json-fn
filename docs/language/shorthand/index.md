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
  normalized to canonical form first (e.g. [property-access spellings](function-calls-and-references.md#variables-and-property-access);
  redundant [`$raw` wrappers](literals-and-data.md)).

File extension: `.jfn`.

---

## Surface model

Every construct is an expression. The surface syntax distinguishes three value
states:

| State | Surface | JSON |
| --- | --- | --- |
| Evaluated expression | bare code | `$call` / `$fn` / `$var` / forms |
| Plain data (values evaluated) | `[...]` / `{k: v}` | array / object |
| Inert (verbatim, un-evaluated) | static JSON with quoted `$`-keys — _inferred_ | `{ "$raw": <json> }` |

## Contents

### Core syntax

- [Source files and lexical structure](files-and-program-shape.md)
- [Literals and data](literals-and-data.md)
- [Variables, property access, calls, and references](function-calls-and-references.md)
- [Operators and precedence](operators-and-precedence.md)
- [Control flow](control-flow.md)
- [Function literals and local bindings](function-literals-and-local-bindings.md)
- [Effects: `do` and `handle`](effects.md)

### Formal references

- [Grammar (informal EBNF)](grammar.md)
- [Type syntax](type-syntax-spec.md)

## Open decisions

- 🔴 **TODO(comments)** — [Lexical structure](files-and-program-shape.md#lexical-structure):
  how `//` comments attach and lower to `$comment`, including group/section
  comments and comments on non-object targets.
- 🟡 **Printer polish for method/chained callees** —
  [Function calls and references](function-calls-and-references.md#method-calls-and-chained-application):
  the pretty-printer parenthesizes access-headed and call-headed callees
  (`(caps.db.query)(sql)`). Parsing and evaluation of the bare form already
  work and round-trip; only canonical printback is deferred.

Everything else in this specification is resolved and implementable.
