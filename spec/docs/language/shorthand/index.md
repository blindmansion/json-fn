# Shorthand language reference

Shorthand is the `.jfn` surface syntax for json-fn. It lowers deterministically
to canonical JSON without changing program semantics.

Identifiers, calls, and operators denote expressions. Quoted strings denote
string values. Arrays and objects are data whose values are evaluated. Static
JSON containing reserved `$`-prefixed keys is preserved under an inferred
[`$raw`](literals-and-data.md#quoted-data--inferred-raw) boundary.

Canonical rendering normalizes equivalent JSON spellings. Its round-trip rule
is:

```text
parse(print(node)) = normalize(node)
```

## Contents

- [Source files and lexical structure](files-and-program-shape.md)
- [Literals and data](literals-and-data.md)
- [Variables, property access, calls, and references](function-calls-and-references.md)
- [Operators and precedence](operators-and-precedence.md)
- [Control flow](control-flow.md)
- [Function literals and local bindings](function-literals-and-local-bindings.md)
- [Effects](effects.md)
- [Type syntax](type-syntax-spec.md)
- [Grammar](grammar.md)
