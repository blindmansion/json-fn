# Checked value ascription

`examples/typed/ledger.jfn:42-44` exposes an awkward gap in the language:

```jfn
put(books, id, handle pure(merge(acct, { balance: acct.balance + delta })) -> Account with {}, msg)
```

The balance arithmetic correctly widens refined `Cents` to `integer`, so the
checker cannot prove that the updated record is still an `Account`. A runtime
contract is appropriate, but today the only checker-recognized way to establish
that contract is to wrap the value in `pure` and immediately unwrap it through
an empty total handler.

Consider a direct checked value-ascription construct that:

- validates a value against a named or inline type at runtime;
- gives the validated expression that type to the checker;
- leaves the value unchanged when validation succeeds; and
- raises a runtime contract error when validation fails.

This should remain distinct from postfix `!`, which only asserts non-nullness.
The goal is to replace the task/handler ceremony above without weakening
refinement checking or introducing an unchecked cast.
