# 1. Lexical structure

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`. Used for variables, function names
  (in call position), parameters, and local names. Must not contain `.` or `[`.
- **Numbers / booleans / null:** as in JSON (`42`, `-3.5`, `true`, `false`,
  `null`). A leading `-` on a numeric token is part of the literal.
- **Strings:** double-quoted, with JSON escape rules (`"\n"`, `"\u2654"`,
  `"\""`). Quoting is the **sole** signal for a literal string.
- **Whitespace** is insignificant inside expressions except as a token
  separator. A physical line break separates complete top-level module
  declarations. Elements in arrays, objects, argument lists, and blocks are
  comma-separated.
- **Comments:** `// …` to end of line and non-nested `/* … */` block comments.
  Both are currently discarded as trivia. 🔴 **TODO(comments):** attachment
  rules (which node a comment lowers to as `$comment`, group/section comments,
  comments on non-object targets) are deferred and unspecified.

---

