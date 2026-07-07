# json-fn syntax highlighting (VSCode / Cursor)

A minimal editor extension that adds language-aware coloring for json-fn
shorthand (`.jfn`) files. It's a pure [TextMate grammar](https://macromates.com/manual/en/language_grammars) —
no build step, no runtime — so it works with any color theme.

## What it highlights

- Keywords: `if` / `then` / `else`, `cond`, `match`, `where`, and the `raw` marker
- Literals: numbers, `true` / `false` / `null`, `"strings"` (with escapes)
- Template strings (`` `…${expr}…` ``) with embedded expression coloring in the holes
- Operators (`+ - * / %`, `++`, `== != < <= > >=`, `&& ||`, `!`) and the
  `=>` (function) / `->` (case) arrows
- Function calls (`name(...)`) and function references (`&name`)
- Object keys / `where` bindings and `.property` accessors
- `// line comments`

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
