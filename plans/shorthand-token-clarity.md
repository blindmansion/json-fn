# Shorthand token clarity

Status: proposed; syntax decisions resolved, implementation pending.

## Summary

Several shorthand tokens currently carry meanings that are either unrelated or
misleading:

- `->` separates `cond`/`match` arms, annotates function results, constructs
  function types, and annotates total handler results;
- `as` resembles TypeScript's erased type assertion even though json-fn performs
  a runtime contract check.

Adopt the following syntax:

```jfn
// Function implementation and callable type retain the same coherent arrow.
increment: (value: integer) -> integer => value + 1
type Formatter = (integer) -> string

// Branch arms use mapping punctuation.
cond {
  value < 0: "negative",
  else: "non-negative"
}

match command {
  "show": showResult(),
  else: unknownCommand()
}

// A total handler names its immediate result contract explicitly.
handle task returns (ScriptState) -> Report with {
  ...
}

// Arbitrary value ascription advertises that it is runtime checked.
parse(input) checked as { id: integer, name: string }
```

This is a shorthand-only change. Canonical JSON forms and runtime semantics do
not change.

## Decision

### Keep `->` for both function signatures and function types

A fully typed function implementation contains the same callable contract
described by a function type:

```jfn
transform: (input: A) -> B => body
type Transform = (A) -> B
```

The implementation additionally carries parameter bindings, defaults,
destructuring, and a body, but the `(A) -> B` relationship is the same. Sharing
the arrow makes that relationship visible. Do not switch function return
annotations to `:`.

`=>` remains the function-body separator.

### Use `:` for `cond` and `match` arms

Change ordered arms from:

```jfn
condition -> result
caseValue -> result
else -> fallback
```

to:

```jfn
condition: result
caseValue: result
else: fallback
```

The surrounding `cond` or `match` keyword establishes that these are ordered,
executable branches rather than data-object properties. At the top level of an
arm, `:` naturally reads as mapping a condition or case to its result. Colons
inside nested object expressions remain governed by the nested expression.

### Use `returns` for total handler result contracts

Change:

```jfn
handle task -> Result with {
  ...
}
```

to:

```jfn
handle task returns Result with {
  ...
}
```

This contract is subtle: it checks the handler's immediate result, is retained
by generated resumptions, and makes unmatched effects contract errors.
`returns` makes that role explicit and avoids misleading arrow chains such as:

```jfn
handle task -> (ScriptState) -> Report with { ... }
```

The replacement reads:

```jfn
handle task returns (ScriptState) -> Report with { ... }
```

Do not use `as` here. `handle task as T with { ... }` is genuinely ambiguous
between annotating the handler result and handling a task expression that has
itself been ascribed as `T`.

### Replace bare `as` with `checked as`

Change:

```jfn
expression as Type
```

to:

```jfn
expression checked as Type
```

Json-fn's operation is not a TypeScript-style erased assertion. It validates
the value at runtime, raises `RuntimeContractError` on failure, and gives the
successful expression exactly the requested type. Function types additionally
install a callable boundary that checks eventual arguments and results.

`checked as` retains the familiar ascription reading without implying “trust
me.” It keeps the existing precedence and non-associativity of `as`. Repeated
checks remain explicitly parenthesized:

```jfn
(value checked as A) checked as B
```

Treat `checked as` as one contextual two-token operator. `checked` need not
become unavailable as an identifier outside that operator position.

Because the operator starts only after a complete left operand, checking a
variable literally named `checked` requires an explicit left operand followed
by the operator:

```jfn
(checked) checked as T
```

The shorter `checked as T` is rejected rather than retaining bare `as` for this
one identifier. Calls and other ordinary uses of the name remain unaffected:
`checked(value)` is still an ordinary call.

## Informal grammar changes

```text
arm          := (expr | "else") ":" expr
funcLit      := "(" params ")" ("->" type)? "=>" body
fnType       := "(" fnTypeParams? ")" "->" type
checkedAs    := orExpr ("checked" "as" type)?
handleExpr   := "handle" expr ("returns" type)? "with" handlerClauses
```

`returns` terminates the handler's task operand at the handler-header level.
If a task operand itself needs a checked ascription, parenthesize it:

```jfn
handle (task checked as Task<Result>) returns Report with {
  ...
}
```

## Canonical forms and behavior

No canonical or evaluator changes are implied:

- `cond` and `match` retain their existing `$cond`, `$match`, `$cases`, and
  `$else` representations and lazy ordered evaluation;
- `checked as` retains the existing `{ "$as": ..., "$type": ... }` canonical
  node and runtime checking behavior;
- annotated handlers still lower to
  `handle(task, clauses, raw(resultSchema))`;
- function signatures and function-type schemas are unchanged.

Canonical shorthand printing must emit only the new spellings.

## Migration and implementation

1. Update the shorthand parser and lexer token documentation. No new token kind
   is required: `checked` and `returns` remain contextual identifier tokens,
   while `:` already exists.
2. Update canonical printing for arms, checked ascriptions, and annotated
   handlers.
3. Replace parse cases and add rejection cases for the old spellings.
4. Add precedence cases for nested object expressions in colon arms,
   `checked as`, function types following `returns`, and parenthesized checked
   task operands. Cover the identifier edge cases `(checked) checked as T`,
   `checked(value)`, and a handler task named `returns`.
5. Update `docs/shorthand-spec.md`, `docs/type-syntax-spec.md`,
   `docs/language.md`, and affected focused documentation.
6. Update the VS Code TextMate grammar and its syntax examples.
7. Migrate `.jfn` examples, plan snippets, shorthand fixtures, and embedded
   shorthand in TypeScript tests.
8. Regenerate canonical `.json` examples only where their source-to-print
   normalization is tested; their semantic representation does not change.

This is intentionally a coordinated syntax migration rather than a period in
which both forms print or parse. Accepting aliases would preserve the ambiguity
the change is intended to remove and weaken canonical shorthand normalization.
