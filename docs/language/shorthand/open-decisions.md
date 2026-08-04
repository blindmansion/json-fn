# 12. Open decisions (tracked)

- 🔴 **TODO(comments)** — [Lexical structure](lexical-structure.md): how `//` comments attach and lower to `$comment`,
  including group/section comments and comments on non-object targets.
- 🟡 **Printer polish for method/chained callees** — [Function calls and references](function-calls-and-references.md): the pretty-printer
  parenthesizes access-headed and call-headed callees (`(caps.db.query)(sql)`).
  Parsing and evaluation of the bare form already work and round-trip; only the
  canonical printback is deferred.

Everything else in this document is resolved and implementable.

---

