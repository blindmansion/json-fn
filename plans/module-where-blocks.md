# Module bindings and trailing `where`

## Summary

Trailing `where` attachment works as designed in expression-body positions,
including standalone expressions, function bodies, parenthesized bodies,
`where` binding values, `cond`/`match` result arms, and `do` body positions.
The existing attachment tests cover the important conditional case:

```jfn
if x > 0 then 1 else fallback(x) where {
  fallback: (n) => n - 1
}
```

Here the `where` belongs to the complete `if`, not only its `else` branch.
Parenthesizing the branch deliberately changes that scope.

A direct module constant is different:

```jfn
ready: (input: integer) -> boolean => input > 0
input: 1
left: 10
right: 20

whole: if p then left else right where { p: ready(input) }
```

The CLI rejects the last line:

```text
parse error at 6:34: expected newline or end of input in module
```

Both of these alternatives currently work:

```jfn
// Parentheses introduce a body.
whole: (if p then left else right where { p: ready(input) })

// A function return is already a body.
whole: (input: integer) -> integer =>
  if p then input else input + 1 where { p: ready(input) }
```

This is not the previously fixed conditional-attachment bug. The parser has
already parsed the complete `if` correctly; it simply does not admit a
trailing body clause directly in a module binding value.

## Why it happens

The parser has two relevant entry points:

- `parseExpr()` parses the operator/expression grammar and stops before
  `where`.
- `parseBody()` parses an expression followed by an optional trailing
  `where`.

Standalone expression mode uses `parseBody()`. Function literals parse their
return expression and then explicitly consume a trailing `where`. Other body
positions similarly admit it.

Module entries go through `parseDataEntry()`, shared with ordinary data-object
entries. After `name:`, that function calls `parseExpr()`, not `parseBody()`.
The module parser therefore sees `where` after a complete entry and reports
that it expected a physical newline or end of input.

This also explains why parentheses work: a parenthesized primary contains a
`body`, so the `where` is consumed before control returns to the module entry.

## Specification mismatch

The informal grammar currently agrees with the implementation:

```text
moduleEntry := "type" ident "=" type | dataEntry
dataEntry   := (ident | string) ":" expr | ident
body        := expr ("where" "{" ... "}")?
```

However, the prose in the local-bindings section says bodies occur at the
"program top level." That can reasonably be read as including module binding
values, while standalone expressions are elsewhere described as a separate
CLI/parser mode rather than `.jfn` program syntax.

The language should make one rule explicit:

1. **Keep the current grammar.** Module constants require parentheses around
   a value with trailing `where`. Update the prose and authoring guide to say
   so.
2. **Allow module binding bodies.** Change module bindings to
   `name: body`, making the unparenthesized form legal.

## Recommended direction

Allow `body` after `:` for module bindings. A module constant is already lazy,
memoized, and expression-valued, so requiring parentheses only at this
ownership boundary is difficult to motivate and easy for authors to mistake
for broken attachment.

Do not achieve this by changing the shared `parseDataEntry()` unconditionally:
that would also change ordinary data-object entry grammar. Parse module
bindings separately, or parameterize the value parser so modules use
`parseBody()` while data objects retain their independently decided grammar.

## Implementation and tests

1. Split or parameterize module entry parsing so `name: body` consumes a
   trailing `where`.
2. Update the informal grammar and remove the ambiguous "program top level"
   wording.
3. Add module-parser coverage for:
   - a constant with an unparenthesized conditional plus trailing `where`;
   - a simple constant `answer: value where { value: 42 }`;
   - the following module binding beginning on the next physical line;
   - a parenthesized branch-local `where`, preserving its narrower scope;
   - duplicate and unused local diagnostics after module lowering.
4. Keep the existing expression parse cases for whole-conditional and
   branch-local attachment.
5. Add a print/parse round trip for a module constant whose canonical value is
   a `$let`.

Call arguments and object entries are separate questions. A lambda body can
end in `where` before the call-argument comma because the lambda itself owns a
body. That does not currently mean an arbitrary argument or object value can
use unparenthesized `expr where { ... }`; decide those grammars explicitly
rather than broadening them accidentally as part of the module fix.
