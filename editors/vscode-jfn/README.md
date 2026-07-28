# json-fn syntax highlighting (VSCode / Cursor)

A minimal editor extension that adds language-aware coloring for json-fn
shorthand (`.jfn`) files. It's a pure [TextMate grammar](https://macromates.com/manual/en/language_grammars) —
no build step, no runtime — so it works with any color theme.

## What it highlights

- Keywords: `if` / `then` / `else`, `cond`, `match`, `where`, `do`, `handle`,
  and the `raw` marker
- Literals: numbers, `true` / `false` / `null`, `"strings"` (with escapes)
- Template strings (`` `…${expr}…` ``) with embedded expression coloring in the holes
- Operators (`+ - * / %`, `++`, `== != < <= > >=`, `&& ||`, `!`) and the
  `=>` (function body) / `->` (function result/type) arrows
- Control-flow arm colons, the contextual `checked as` operator, and total
  handler `returns` contracts
- Function calls (`name(...)`) and function references (`&name`)
- Object keys / `where` bindings and `.property` accessors
- `// line comments` and `/* block comments */`
- **Types** (`docs/type-syntax-spec.md`):
  - `type Name = <type>` declarations — the name, the `=`, and the whole type
    expression are fully colored (see below)
  - Type primitives (`null boolean number integer string any never`), named
    refs, unions (`|`), the array suffix (`[]`), objects/tuples/maps, function
    types, and optional keys (`?`)
  - Refinements (`& min(0)`, `& pattern("^u_")`, `& unique`, …)

### How type highlighting works (and its limits)

Type highlighting comes in two tiers, because a TextMate grammar can't do the
lookahead the real parser does:

1. **`type Name = …` declarations** get a dedicated, self-terminating type
   sub-grammar, so everything inside is colored precisely — including nested
   objects, tuples, function types, and multi-line unions. The scope ends when
   the next newline-separated module declaration begins.
2. **Signatures** (`(x: T) -> R =>`) are colored at the token level: primitives,
   `[]`, `->`, `?`, and refinements light up, and param names read as
   properties. Named type refs in a signature (e.g. `UserId`) can't be told
   apart from ordinary identifiers there, so they get the plain variable color —
   this is expected and degrades gracefully.

See [`examples/types.jfn`](../../examples/types.jfn) for a program that
exercises the type syntax and contextual shorthand tokens.

## Install (local, unpublished)

Extensions are loaded from a per-editor folder. Symlink this directory in so
edits here are picked up live:

```bash
# Cursor
ln -s "$(pwd)/editors/vscode-jfn" ~/.cursor/extensions/json-fn

# VSCode
ln -s "$(pwd)/editors/vscode-jfn" ~/.vscode/extensions/json-fn
```

Then fully restart the editor (Cmd+Q / Quit, not just reload). Open any `.jfn`
file — the language selector in the status bar should read **json-fn**.

To confirm which grammar scope a token got, run
`Developer: Inspect Editor Tokens and Scopes` from the command palette.

## Iterating on the grammar

After editing `syntaxes/jfn.tmLanguage.json`, run
`Developer: Reload Window` to see changes. The grammar file is plain JSON, so a
JSON validator will catch typos before reload.
