# Plan: allow leading-pipe union types

Status: **proposed.**

This is an independent shorthand type-parser, type-documentation, printer
round-trip, and focused-test change. It does not change canonical schemas, the
checker, or evaluation.

Accept an optional `|` before the first member of any shorthand union type.
Both forms would mean the same thing:

```jfn
type Status =
    { tag: "open" }
  | { tag: "closed" }

type Status =
  | { tag: "open" }
  | { tag: "closed" }
```

The shorthand printer would continue to emit the first, canonical form.

## Motivation

Leading pipes are a common multiline-union convention and are unambiguous at
the start of a json-fn type expression. Rejecting one currently produces
`expected a type, found 'pipe'` even though the intended type is clear.
Accepting the form is simpler for authors and agents than teaching a
language-specific prohibition.

## Syntax and scope

Change the type grammar in
[`docs/language/shorthand/type-syntax-spec.md`](../docs/language/shorthand/type-syntax-spec.md) from:

```text
union := refined ( "|" refined )*
```

to:

```text
union := "|"? refined ( "|" refined )*
```

The optional leading pipe applies wherever a type expression is accepted,
including declarations, function signatures, grouped types, and `Task<A>`.
Keeping the rule in the shared type grammar avoids context-specific behavior.

A leading pipe does not need at least two members, so `| string` is accepted
and normalizes to `string`. Malformed separators such as `A | | B` remain
errors.

## Implementation

In
[`typescript/src/shorthand/type-parser.ts`](../typescript/src/shorthand/type-parser.ts),
update `parseUnion` to consume one optional leading `pipe` token before parsing
the first refined member:

```ts
private parseUnion(): Schema {
  if (this.peekType() === "pipe") this.advance();

  const arms = [this.parseRefined()];
  while (this.peekType() === "pipe") {
    this.advance();
    arms.push(this.parseRefined());
  }
  if (arms.length === 1) return arms[0]!;
  return normalizeUnion(arms);
}
```

No canonical schema, checker, evaluator, or printer changes are required.
[`typescript/src/shorthand/type-printer.ts`](../typescript/src/shorthand/type-printer.ts)
should continue printing unions without a leading pipe.

## Tests

Add parser coverage proving:

1. `A | B` and `| A | B` lower to the same canonical schema.
2. A multiline module declaration accepts a leading pipe.
3. The syntax works in a nested type context such as `Task<| string | null>`.
4. A single leading-pipe member normalizes to that member.
5. Empty and repeated members (`|` and `A | | B`) still fail with positioned
   parse errors.
6. Printing a parsed leading-pipe union emits the canonical no-leading-pipe
   form and reparses identically.
7. A malformed function type with no type before `=>` remains a positioned
   parse error.

Legalizing the leading token may legitimately change which token or message is
reported for some currently malformed `|` placements. Negative tests should
assert rejection and useful positions without freezing stale wording.

Relevant suites are
[`typescript/test/parse-errors.test.ts`](../typescript/test/parse-errors.test.ts)
and the shorthand parser/printer tests under
[`typescript/test`](../typescript/test).

## Documentation

- Update the grammar and union examples in `docs/language/shorthand/type-syntax-spec.md`.
- Mention in `docs/guides/writing-jfn.md` §10 that a leading pipe is accepted for
  multiline unions but omitted by canonical printing.
- Add a parse case if the shared shorthand parse corpus covers accepted type
  syntax.

## Acceptance criteria

- Both union styles parse to identical canonical JSON.
- Leading-pipe syntax behaves uniformly in every type-expression context.
- Canonical printing remains stable and omits the leading pipe.
- Existing malformed-union diagnostics remain positioned and clear; exact
  wording may change where the newly legal leading token shifts the first
  failure.
- `bun run check` and `bun test` pass.
