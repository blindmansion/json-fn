# Source files and lexical structure

## Lexical structure

- Identifiers match `[A-Za-z_][A-Za-z0-9_]*`. They cannot contain `.` or `[`.
- Numbers, booleans, and `null` use JSON syntax. A leading `-` on a number is
  part of the literal.
- Strings are double-quoted and use JSON escapes. Quoting distinguishes string
  values from identifiers.
- Whitespace is insignificant within an expression except as a token separator.
- Arrays, objects, argument lists, and blocks use commas between entries.
- `//` line comments and non-nested `/* … */` block comments are discarded.

## Files and program shape

A `.jfn` file is an implicit module: a newline-separated sequence of bindings
and type declarations without surrounding braces. It lowers to one canonical
JSON module object. A declaration may span lines. A line break separates
declarations only after the preceding expression or type is complete.
Top-level commas and multiple declarations on one line are invalid. Module
binding names cannot start with `$`.

Module entries form the outermost lexical scope. They are strict and
dependency-ordered: the value entries in the selected entry's static reference
closure evaluate at invocation start, before the entry function is invoked,
and entries outside that closure do not evaluate (see
[Modules and scope](../json/modules.md)). Entries need not be topologically
sorted in source, sibling functions may recurse mutually through calls, and
dependency cycles are errors. Every entry is
available through `$var`; literal function entries are also callable by name.
Module functions are not copied into escaping closures.

```jfn
otherColor: (color) => if color == "w" then "b" else "w"
pieceType:  (piece) => upper(piece)
```

```json
{
  "otherColor": {
    "$params": ["color"],
    "$return": { "$if": { "$call": "eq", "$args": [{ "$var": "color" }, "w"] }, "$then": "b", "$else": "w" }
  },
  "pieceType": { "$params": ["piece"], "$return": { "$call": "upper", "$args": [{ "$var": "piece" }] } }
}
```

The environment selects a named entry and supplies outer builtins and
capabilities. See [Modules and scope](../json/modules.md) and the
[environment contract](../../deployment/environment-contract.md).

Standalone expression input is not `.jfn` file syntax.

