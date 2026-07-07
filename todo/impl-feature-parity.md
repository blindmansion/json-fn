# Implementation feature parity

We iterate on the language in the **TypeScript** implementation first, then port.
This file tracks what has landed in TS (and sometimes Rust) but is **not yet
propagated** to the other interpreters. The evaluator lives in **TS, Rust, Go,
Python**; the shorthand parser/printer lives in **TS (parser + printer)** and
**Rust (parser only)**.

Plans go stale; this list is the source of truth for "what's left to port."
Add a shared conformance case for each item as it lands (see
`todo/conformance-tests.md`) so the ports stay pinned.

## Status matrix

| Feature | TS | Rust | Go | Python |
| --- | --- | --- | --- | --- |
| Comparison shorthands (`$lt`/`$lte`/`$gt`/`$gte`/`$eq`/`$neq`) | ✅ | ✅ | ✅ | ✅ |
| `match`/`cond` `else` expressions | ✅ | ✅ | ✅ | ✅ |
| Structural equality `jsonEq` | ✅ | ✅ | ✅ | ✅ |
| `log` + opt-in log sink | ✅ | ✅ | ✅ | ✅ |
| Variadic `strcat` | ✅ | ✅ | ✅ | ✅ |
| Fuel + value-size limits | ✅ | ✅ | ✅ | ✅ |
| Wall-clock deadline backstop | ✅ | ✅ | ✅ | ✅ |
| **Module scope (`callProgram`)** | ✅ | ❌ | ❌ | ❌ |
| **P4 lexical-first name resolution + bare refs** | ✅ | ❌ | ❌ | ❌ |
| **`$literal` → `$raw` rename** | ❌ | ❌ | ❌ | ❌ |
| Shorthand parser | ✅ | ✅ | ❌ | ❌ |
| Shorthand printer (`.jfn`) | ✅ | ❌ | ❌ | ❌ |
| Trailing `where` on cond/match/if/binding + parens | ✅ | ❌ | — | — |
| `cond` requires `else ->` (parser policy) | ❌ | ❌ | — | — |

## Evaluator ports (Go / Python / Rust)

### 1. `$literal` → `$raw` rename (cross-cutting, all four)
The shorthand parsers already lower `raw <json>` to `{ "$raw": <json> }`, but
**every evaluator still only recognizes `$literal`** — so shorthand `raw`
islands currently evaluate as plain data instead of inert verbatim JSON. Rename
the evaluator key (and the "cannot have other properties" guard) to `$raw` in
TS, Rust, Go, Python. Decide alias-vs-hard-rename (recommendation was hard
rename while unlocked). Update `examples/chess.jsonc` and docs.
See `plans/shorthand-stdlib-changes.md` §2.

### 2. Module scope / `callProgram` (TS-only → port to Go, Python, Rust)
Top-level object becomes the outermost lazy `letrec` scope over the host
registry; add a `callProgram(module, entry, args, baseRegistry, limits)` entry
point. Extract a `buildScope` helper from the function-body evaluator, layer the
module over stdlib (the single boundary rule), reuse existing laziness + cycle
detection, capture module functions as closures over the module scope.
Full language-agnostic porting guide (and the observable-semantics test matrix)
is in `plans/module-scope.md` (see "Porting to Go / Python / Rust").

### 3. P4 lexical-first name resolution + bare references (TS-only → port)
A function-valued parameter / `where`-local / module binding shadows a
same-named stdlib/operator uniformly (operator desugaring, direct call, bare
ref); a bare registry name in value position resolves to its `&`-free reference.
Three resolution sites plus closure-capture (`replaceVars`) via a scoped
`localFns` set — TS shipped the full version including Site 2 Option A.
Site-by-site plan + regression checklist: `plans/p4-name-resolution.md` (§4, §8
step 4). Documented behavior lives in `docs/shorthand-spec.md` §4/§5.

## Shorthand parser / printer parity

### 4. Shorthand printer for Rust (TS-only → port)
`.jfn` pretty-printer (canonical JSON → shorthand) exists only in TS
(`typescript/src/shorthand/printer.ts`). Rust has a parser but no printer; Go
and Python have neither. Port the printer to Rust for round-trip parity, pinned
by the print/parse conformance suite.

### 5. Rust parser: trailing-`where` attachment points
TS extended trailing `expr where { … }` to attach on `cond`/`match` arm results,
`if/then/else` branches, `where`-binding values, and inside parenthesized groups
(`parseBody`, commits P4 + "trailing `where` in parens"). The Rust parser still
only attaches `where` to a function body. Port the `parseBody`/`buildScope`
change so both parsers agree.

### 6. `cond` requires an `else ->` arm (TS + Rust parser policy)
`match` requires `else` at parse time; `cond` does not (fails only at runtime).
Make `parseCond` throw `"cond requires an 'else ->' arm"` in **both** the TS and
Rust parsers, and update `docs/shorthand-spec.md` §7. Canonical `$cond` keeps
`$else` optional — this is an authoring policy, not an evaluator change.
See `plans/shorthand-action-items.md` §P2.

## Deferred (not blocking parity)

- **Shorthand parser for Go / Python.** Neither has one; only TS + Rust parse
  `.jfn`. Porting is optional until we need `.jfn` authoring from those hosts —
  track as a future item rather than a close-out.
