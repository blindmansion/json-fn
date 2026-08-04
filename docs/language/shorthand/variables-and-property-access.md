# 5. Variables and property access

A bare identifier is a variable (`{"$var":"x"}`). Any access on it lowers to a
`$get`/`$from` chain rooted at that `$var`; access on a non-variable expression
lowers to a `$get`/`$from` chain rooted at that expression.

A bare identifier that is **not** a lexical binding but **is** a registered
function resolves to that function _reference_ (i.e. `&`-free; see
[Function calls and references](function-calls-and-references.md)). The
fallback only applies to a plain name: a name with a trailing path (`length.foo`)
that has no lexical binding is an error rather than resolving the reference and
then walking into it.

```jfn
x                         // {"$var":"x"}
a.b                       // {"$get":"b","$from":{"$var":"a"}}
a.b.c                     // {"$get":["b","c"],"$from":{"$var":"a"}}
a[0]                      // {"$get":0,"$from":{"$var":"a"}}
a[i]                      // {"$get":{"$var":"i"},"$from":{"$var":"a"}}
f(x).b                    // {"$get":"b","$from":{"$call":"f","$args":[{"$var":"x"}]}}
```

Lowering rules:

- Inside `[...]`, an **integer or quoted string** is a **static** key/index; a
  **bare identifier or any other expression** is a **computed** key.
- A run of consecutive **static** segments folds into one `$get` (a single
  string/number, or an array path for multiple): `a.b[0].c` →
  `{"$get":["b",0,"c"],"$from":{"$var":"a"}}`.
- A **computed** segment gets its own `$get`, wrapping the prior result as its
  `$from`: `a.b[i]` →
  `{"$get":{"$var":"i"},"$from":{"$get":"b","$from":{"$var":"a"}}}`.

Canonical JSON is always the `$get`/`$from` form. There is no `$var` + `$get`
pairing and no dotted `$var` path-string form: `$var` is a bare variable name,
and every property access is a `$get`/`$from` pair.

An access chain **in call position** is a method call: the chain evaluates to a
function value that is then applied (`caps.db.query(sql)`). See
[Function calls and references](function-calls-and-references.md).

---

