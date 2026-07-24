# Future authoring improvements

Status: **parking lot.** These ideas are not commitments. Revisit them when
authoring experience or real programs justify the added surface area.

## Shorthand syntax

### Array-pattern parameters

Destructure tuple-shaped arguments directly:

```jfn
map(([key, value]) => { key, value }, entries(obj))
map(([x, y]) => distance(x, y), points)
```

This avoids repeated indexing and complements object-pattern parameters. A
small first version could allow only fixed identifier patterns, without
nesting, defaults, optional elements, or rest.

### Pipe operator

Make transformation pipelines read in execution order:

```jfn
orders
|> filter(isOpen)
|> map(toInvoice)
|> sum
```

The main design decision is argument placement. Since collection builtins are
generally callback-first and data-last, `value |> f(arg)` would be most useful
if it lowered to `f(arg, value)`. A placeholder form would be more explicit but
would introduce additional syntax.

Lowering stages to ordinary nested calls could preserve more precise
typechecking than the existing `pipe([functions], value)` builtin.

### Chained comparisons

Allow bounds to read naturally:

```jfn
0 <= x <= 7
```

Each operand must be evaluated once. The planned canonical `$let` node could
lower a nontrivial middle expression without duplicating it. Limit chaining to
ordered comparisons; equality chains are ambiguous and unnecessary.

## Type syntax

The current type syntax is specified in
[`docs/type-syntax-spec.md`](../docs/type-syntax-spec.md).

### Local type declarations

Allow a type declaration inside a function body:

```jfn
slideDir: (...) -> integer[] => ... where {
  type Dir = { dr: integer, dc: integer },
  ...
}
```

The type-name scope is currently one flat definition pool. Proper local types
would require a scoped `Defs` chain plus a resolution strategy for unqualified
`#/$defs/Name` references. Hoisting would be simpler but would expose local
names globally and create cross-function collisions.

### Annotated `where` locals

Allow an optional checked annotation on a local:

```jfn
move: parseMove(moveInput) : Move | null
```

This is mostly redundant with callee return types and checked value ascription,
and the syntax is awkward. Revisit only if documentation-grade local
annotations prove useful.

### Bodyless signatures

Allow declaration-only signatures:

```jfn
fn pieceColor(piece: Cell) -> Color | null
```

Host functions are currently injected rather than declared in a module. This
would become useful only if json-fn gains declaration files or another need to
describe capability surfaces separately from their implementations.

## Authoring and diagnostics

### Recursive callbacks require explicit references

A bare self-reference used as a callback can force its module binding while
that binding is already being evaluated:

```jfn
evaluate: (node) => map(evaluate, node.children)
```

Using `&evaluate` avoids the circular value read. Either bare self-references
should resolve as function references, or the diagnostic and shorthand
documentation should direct authors to `&name`.

### Width-aware printing

The shorthand printer keeps arrays on one line and expands every multi-key data
object across multiple lines. A width-aware layout should wrap long arrays and
inline short objects when they fit, especially for object-pattern call sites
and lists of small records.

### Document `groupBy` key conversion

`groupBy` stores groups in a JSON object, so numeric callback results become
string keys. For example, grouping by rank `13` and then calling `entries`
produces `["13", values]`. Document this clearly; callers that need the original
number must convert the key with `num`.
