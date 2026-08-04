# 2. Expressions overview

Every construct is an expression. Three value "states" from the language are
made explicit in the surface syntax:

| State                          | Surface                                       | JSON                   |
| ------------------------------ | --------------------------------------------- | ---------------------- |
| Evaluated expression           | bare code                                     | `$call` / `$fn` / `$var` / forms |
| Plain data (values evaluated)  | `[...]` / `{k: v}`                            | array / object         |
| Inert (verbatim, un-evaluated) | static JSON with quoted `$`-keys — _inferred_ | `{ "$raw": <json> }`   |

---

