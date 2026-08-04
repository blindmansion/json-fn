# 9. Files and program shape

A `.jfn` file is an **implicit module**: a newline-separated sequence of named
bindings and type declarations without surrounding braces. It lowers to one
canonical JSON object mapping names to expressions. A declaration may span
multiple lines; a line break is a module separator only after its expression or
type is complete. Top-level commas are not accepted, and two declarations
cannot share a line. Commas remain required in nested comma-separated syntax.

This object is a distinct persistent module registry, not a function body or a
`$let` encoding. Top-level names (constants _and_ functions) are visible via
`$var` throughout the file, and literal functions are callable via `$call`.
Constants are lazy, memoized, order-independent, mutually recursive, and
cycle-checked. Module functions remain registry-backed for the whole program
and are not copied into escaping closures. The host supplies the parent
registry (stdlib + native builtins) and picks an entry point to invoke.

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

**How a module is consumed is a host concern**, unchanged from canonical JSON: the
host treats the resulting object as the outermost scope over the stdlib
registry and chooses a named entry point (as with `pipeline.jfn` and
`dungeon.jfn`). Standalone expressions are a separate parser/CLI mode and are
not `.jfn` file syntax.
See [Environment contract](../../deployment/environment-contract.md) for portable entry linking
and [Durable task hosting](../../runtime/durable-host.md) for persistent execution.
The shorthand only guarantees the JSON it produces.

> **Future direction (not specified):** module-level `import` / `export` may
> extend this file-level module syntax.

---

