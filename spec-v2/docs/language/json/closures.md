# Closures

Evaluating a function-body expression creates a **function value**: the body
exactly as authored, after program normalization, plus a **capture record**
holding the evaluated values of the body's free variables. The body is never
rewritten. This also occurs when the body is used directly as a call's callee.

Capture happens at **creation**. There is no separate escape step: a value
that leaves its defining scope already carries its record, and escaping is
the identity on it — escape is idempotent.

## The capture record — `$captures`

The record is the `$captures` field: a plain object mapping variable names to
captured values, a sibling of `$params`/`$return` alongside
`$runtimeContract`. Any JSON value can be captured, including function
values. An empty record is omitted, never `{}`, so a body with no free
variables evaluates to a value byte-identical to its normalized source body.

`$captures` is not a source field. It is invalid in modules and authored
expressions and appears only on evaluated function values.

A record entry is **data by position**: a captured value whose keys look like
`$call` is never at risk of execution, and because nothing is marked, that
inertness survives serialization by construction.

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
  "$captures": { "x": 10 }
}
```

The inner body is unchanged — `x` resolves through the record when the value
is applied. `add` is a builtin, resolved by name, not captured. The returned
value remains callable as a function.

The record scopes over **parameter defaults** as well as `$return`: a default
expression may read any record entry.

## The capture relation

The free variables of a body are the names it statically references — the
same transitive `$var` / named-`$call` / `$fn` relation as
[`$let` dependency order](expressions.md#dependency-order) — minus the names
bound by the body's own parameter surface and inner scopes. Record names
therefore cannot collide with the value's own `$params` binders, and each
captured value is stored once, however many reference sites read it.

What each free name contributes:

- A **value-position reference** to any in-scope binding — a `$let` binding,
  an enclosing parameter, an enclosing capture, or a module value entry —
  contributes an entry holding the **evaluated value**. Strict
  dependency-ordered bindings guarantee the value exists: a value-position
  reference creates an order edge, so the binding evaluated first.
- A **call-position reference to a local function binding** — sibling,
  enclosing, or self — leaves the name a name in the body; the record
  carries a **group entry** enabling by-name application after escape (see
  [Captured local functions](#captured-local-functions)). The call-position
  exemption means the sibling's value may genuinely not exist at creation
  time, so these entries hold program text, not values.
- **Module functions and builtins** are never captured. They resolve by name
  where the value is applied. Module *value* entries are captured by value:
  resumed continuations do not re-enter module entries.

The call-position exemption removes only the order edge to the sibling
function itself; the static-reference relation continues **through** the
exempted call, so a called sibling's own value-position free names join the
creating body's — creating `even` (which calls `odd`, which reads `limit`)
captures `limit`'s value.

## Captured local functions

Genuine self- and mutual recursion is the one place attachment is not "store
the value": the call-position exemption means no order edge exists, and the
sibling function's value may not exist when the escaping closure is created.
What always exists is the sibling's **source body**. The record generalizes
to a flat binding group:

- The **capture group** is the created function plus the transitive closure
  of the local function bindings it references in call position.
- The record carries one **open-body entry** per group member referenced by
  name from the escaping body or from any member's body: the member's
  unrewritten literal binding value — its whole authored body object,
  preserving `$params` and `$comment` — with **no record of its own**. It
  also carries one value entry per name in the union of the group's
  value-position free names.
- A member that is *both* called and taken as a value contributes by its
  static reference kind: any value-position reference forces the order edge,
  so the value exists and is captured, and call-position resolution applies
  that captured value. Open-body entries appear only for members reached
  **exclusively** through call-position references. Record shapes depend only
  on static reference kinds, never on evaluation-order accidents, so they are
  deterministic.

When a function value is applied, names in its body resolve through the
[resolution order](modules.md#name-resolution), with the value's record as
the capture component of tier 2. A function-valued or open-body record entry
applied by name from within that scope resolves its own body through **the
same containing record**: the record is one flat, mutually recursive binding
group — semantically a `$let` whose bindings are already evaluated, which is
why the [audit rendering](#printing--an-audit-rendering) is faithful.

A self-recursive escape stores its own body twice — the outer body plus its
own open-body entry — and each group member's record is self-similar one
level deep. Open bodies carry no records, so the shape terminates by
construction; content addressing deduplicates it at rest.

```json
{
  "$params": ["base"],
  "$return": {
    "$let": {
      "go": {
        "$params": ["x"],
        "$return": {
          "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
          "$then": { "$var": "base" },
          "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
        }
      }
    },
    "$in": { "$var": "go" }
  }
}
```

Called with `[42]`, this returns:

```json
{
  "$params": ["x"],
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
    "$then": { "$var": "base" },
    "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
  },
  "$captures": {
    "base": 42,
    "go": {
      "$params": ["x"],
      "$return": {
        "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
        "$then": { "$var": "base" },
        "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
      }
    }
  }
}
```

The `$then` arm still reads `{ "$var": "base" }` — nothing was substituted.
`base` is a value entry (value-position reference through the exempted
self-call), and `go` is an open-body entry: the self-call resolves by name
through the containing record, so recursion survives escape, and both the
outer body's and the entry's `base` resolve through the same record.

## Body identity and hashing

The body subtree of any function value canonically encodes **byte-identical**
to the corresponding normalized source subtree. A suspended continuation
therefore hashes and diffs against the deployed program: its body verifies
against source, and its record reads as a state snapshot. `$comment` is
preserved on returned bodies trivially, since the body is never rewritten.

Function values are values and hash under `jfn:value:v1`; program
normalization (`jfn:module:v1`) never sees a record. No new hash domain and
no new [hashing](../../runtime/hashing.md) rule is involved — canonical-JSON
key sorting already covers record encoding.

Sharing one record across multiple applications of the same continuation is
sound because the language has no mutation; a pending value's `resume` may be
applied more than once.

## Validation at value boundaries

Function values arrive as data — workflow records, host results, arguments —
and the record is validated where `$runtimeContract` is: fail-closed, at
hydration and application, never by trusting shape:

- `$captures` must be a plain non-null object;
- record names must be valid identifiers and disjoint from the value's own
  `$params` binders (impossible from creation; enforced on hand-crafted input
  rather than given a shadowing meaning);
- open-body entries must be valid function-body shapes;
- in source, `$captures` remains invalid.

A violation is a validation error naming the offending field, in the same
class as the other rehydration validations. The
[structural-depth limit](../../runtime/execution-limits.md#structural-depth)
applies to closure captures at every boundary, as elsewhere.

## Printing — an audit rendering

A function value prints with its record as the local-binding form, so a
persisted workflow state reads as bindings over the unrewritten body:

```jfn
(x) => if x <= 0 then base else go(x - 1) where {
  base: 42,
  go:   (x) => if x <= 0 then base else go(x - 1)
}
```

This is **audit output for values, not a source form**. The round-trip law
`parse(print(node)) = normalize(node)` is scoped to programs, and programs
never contain records. Parsing the rendering back yields a body-top eager
`$let` of literal values — semantically faithful, since the record is a flat
group of strict, already-evaluated bindings callable by name — but not the
canonical value shape. Value identity and interchange are the canonical JSON
itself (`jfn:value:v1`), never the rendering. Two consequences:

- a captured value that is expression-shaped data prints under the printer's
  inferred-`$raw` quoting (see
  [Literals and data](../shorthand/literals-and-data.md)), so the rendering
  never reads as code;
- the record scopes over parameter defaults as well as `$return`, which a
  body-top local-binding clause cannot literally express. The scope rule
  stated [above](#the-capture-record--captures) is normative; the rendering
  approximates it.

Program normalization never applies to values, so the normalizer needs no
record rule.
