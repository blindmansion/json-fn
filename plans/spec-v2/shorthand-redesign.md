## Resolved

1. **`let { … } in expr`** replaces `where`; colon bindings, matches canonical `$let`/`$in` order.
2. **K&R formatting** — brace-form bodies hug `=>`, closers at column 0; long signatures wrap in the param list.
3. **Function declarations** — `name(params) -> Type => body`; `name(` = function, `name:` = value. Colon form valid input, sugar is canonical.
4. **`type Name: T`** — colon for type definitions; `=` accepted as input, prints back as `:`.
5. **Type-name casing** — lint-level convention only.
6. **Imports** — contract-injected namespaces, dot access, no guest import statement.
7. **Exports** — `pub` prefix per declaration; unmarked = private once shipped; everything visible until then.
8. **Pipe `|>`** — insert-last, left-assoc, between `||` and `checked as`, bare-name RHS, no placeholder, lowers to nested calls; leading-pipe multiline via the peek-ahead rule shared with leading-pipe unions.
9. **`&` demoted** — bare names idiomatic and canonical; `&` only under shadowing.

## Pending

1. **Pipe printback** — normalize away vs. render deep call chains (≥3) as pipelines.
2. **`&` durability semantics** — by-name `$fn` vs. captured closure at suspension boundaries.
3. **Stdlib arg-order audit** — flush out data-first stragglers for pipeline ergonomics.
4. **Import canonical form** — `$imports` shape, hash pinning location, access-root-only vs. first-class.

---

```jfn
// inventory.jfn — order pricing and fulfillment for the demo shop.
// Injected namespaces (per contract): `catalog` (pure module), `effects.db`,
// `effects.log`.

type Cents: integer

type Line: { sku: string, qty: integer, unit: Cents }

type Order: { id: string, lines: Line[], coupon?: string }

type Quote:
    { tag: "ok", total: Cents }
  | { tag: "rejected", reason: string }

// ----- internal helpers (unmarked = private) ------------------------------

lineTotal(line: Line) -> Cents => line.qty * line.unit

// `discount` shadows nothing; bare-name references below stay sigil-free.
discount(total: Cents, coupon: string) -> Cents => match coupon {
  "SAVE10": total - total / 10,
  "FREEBIE": clamp(total - 500, 0, total),
  else:      total
}

// Parameter `lineTotal` shadows the module function — `&` breaks the shadow.
auditLine(lineTotal: Cents, lines: Line[]) -> boolean =>
  lines |> map(&lineTotal) |> sum == lineTotal

// ----- public surface -----------------------------------------------------

pub quote(order: Order) -> Quote => let {
  merged:  order.lines |> filter((l) => l.qty > 0) |> sortBy((l) => l.sku),
  gross:   merged |> map(lineTotal) |> sum,
  net:     if order.coupon != null
             then discount(gross, order.coupon!)
             else gross
} in cond {
  length(merged) == 0: { tag: "rejected", reason: "empty order" },
  net > catalog.maxCharge: { tag: "rejected", reason: "exceeds limit" },
  else: { tag: "ok", total: net checked as Cents }
}

pub fulfill(order: Order) -> Task<string> => do {
  q: quote(order),
  _ <- effects.log.write(`quote ${order.id}: ${q.tag}`),
  receipt <- match q.tag {
    "ok":  effects.db.insert({ order: order.id, total: q.total }),
    else:  pure("skipped")
  },
  pure(receipt)
}

pub summary(orders: Order[]) -> string =>
  orders
    |> map(quote)
    |> filter((q) => q.tag == "ok")
    |> map((q) => str(q.total))
    |> join(", ")
```

Everything's in there: `type` with colons (including a hugged union), private helpers vs. `pub`, function-declaration sugar with a value-vs-function contrast (`catalog.maxCharge` via injected namespace), `let…in` feeding a `cond`, K&R hugging throughout, leading-pipe multiline chains, insert-last pipes with bare-name RHS (`map(quote)`, `map(lineTotal)`), the `&` shadow-breaker in `auditLine` next to sigil-free references elsewhere, plus older machinery for flavor — `?`/`!` optionals, template strings, `checked as` on a pipeline-adjacent expression, and a `do` block mixing pure bindings with effects.

One thing writing it surfaced: `map(quote)` and `map(lineTotal)` read beautifully, which is the demoted-`&` decision paying off — but note `summary` calls `quote` on each order, and `q.tag == "ok"` narrowing across pipe stages will lean on whatever inference you give per-stage types. Worth keeping this file around as a checker test case.
