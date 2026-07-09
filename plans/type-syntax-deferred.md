# Type Syntax — Deferred Work (post-v1)

Status: **parking lot.** Everything here was consciously cut from the first
authoring-syntax pass so v1 can ship a small, predictable surface. Revisit once
the v1 type syntax (module-level `type` decls + inline `(typed params) -> Ret =>`
signatures) is implemented end-to-end (parser + printer + spec).

The canonical JSON form (`typescript/src/check/`) already exists and is not in
question here — this is purely about **surface syntax** and the couple of
**runtime** features some of it depends on.

---

## v1 decisions this doc assumes (for reference)

So the deferred items read in context, v1 locks in:

1. **Named types are module-top-level only.** `type X = <type expr>` entries in
   the module's braced object lower into the reserved `$types` sibling (a flat
   `$defs` pool). One flat type-name scope.
2. **Every function *declaration* is fully typed.** All params annotated with
   `: T`, return type mandatory via `-> Ret` before `=>`. No inference-based
   omission (recursion needs the written return type; see §2 below).
3. **Inline lambdas at builtin HOF call sites are exempt** — contextually typed,
   no annotations. The rule: annotations required iff the funcLit is the RHS of a
   `name:` binding.
4. **`where`-locals are never annotated** — typed lazily by synthesis.
5. **Assertion operator is in v1** as the escape hatch for the narrowing gap
   (recommended spelling `x!`, lowering to a runtime-checked node; exact spelling
   still to iterate).
6. **Host/builtin functions are injected, never user-declared.**

---

## 1. Local / nested type declarations

Allow `type X = ...` inside a function body (e.g. a `where` block), scoped to
that function rather than the module.

```jfn
slideDir: (...) -> integer[] => ... where {
  type Dir = { dr: integer, dc: integer },   // local, not visible outside slideDir
  ...
}
```

**Why deferred — it is *not* free.** The term scope (variables) is a parent
chain, but the **type-name scope is a single flat dictionary**: `module.ts`
builds `defs = { ...builtins.$defs, ...module.$types }` once, and `resolveRef`
does a flat lookup with no parent link. Supporting local types needs one of:

- **(a) Hoist to the module pool** — trivial, but `Dir` becomes module-global and
  cross-function name clashes become real (two functions each with a local `Move`
  collide).
- **(b) A scoped `Defs` chain** — mirror the term scope's parent chain for types
  and thread it through `resolveRef` + the `$ref` machinery in `subsumption.ts`.
  `$ref` strings are currently unqualified (`#/$defs/Name`), so this needs
  name-mangling or a resolution order. Non-trivial.

**Plan:** keep v1 flat (module-top-level only). Revisit (b) only if real code
demands locally-scoped type names — none of the current examples do.

---

## 2. Return-type inference (decided against for v1, recorded here)

Floated: let a declaration omit `-> Ret` and infer it from the body.

**Rejected for v1** because:

1. **Recursion deadlocks.** Typing a self-call (`slideDir` → `slideDir`) needs
   the callee's signature; if the return is inferred, that requires synthesizing
   the body, which contains the self-call. The lazy-local cycle guard fires and
   degrades to `any`.
2. **Inferred ≠ named/canonical.** Synth yields structural types (a raw `anyOf`
   of `$cond` arm types, a closed object of `const` fields) — not `Status`,
   `State`. Names are lost in errors and in the escaping `$sig`.
3. **Consistency** with "all params must be typed."

Inference stays an *internal* tool (lambda bodies at builtin call sites,
constants). Reopen only if the ergonomics of writing return types on every
one-liner proves painful in practice.

---

## 3. Annotated `where`-locals

An optional form to pin a local's type as a checked assertion:

```jfn
move: parseMove(moveInput) : Move | null,   // ": Move | null" checked against the inferred type
```

**Deferred** as redundant (the callee already declares its return type, so synth
already knows it) and awkward (`name : expr : Type` — three colons on a line). If
a use site needs a narrower type, that is the assertion operator (v1), not a
binding annotation. Revisit if there's demand for documentation-grade local
annotations.

---

## 4. Optional params (`?`) and parameter defaults (`=`)

Two related surface features, both cut from v1. v1 signatures are **all params
required + typed**.

### 4a. Optional `?` — cheap, could land early

Because the language **already nulls missing args**, `?` needs no runtime change
— it means "may be omitted; type is `T | null`" plus a min/max arity check:

```jfn
greet: (name: string, punct?: string) -> string => strcat(name, punct)
```

```json
{ "$sig": { "params": [{ "type": "string" }, { "type": ["string", "null"] }],
            "returns": { "type": "string" } },
  "$params": ["name", "punct"] }
```

The only checker change is arity: `checkArity` currently enforces *exact* arity
(modulo rest); optional params make it a min/max range. Small, self-contained. It
is bundled here only because it's naturally paired with defaults and v1 is
cleaner with strict arity — **it can be pulled into v1 independently if wanted.**

### 4b. Defaults `=` — needs a runtime feature first

```jfn
greet: (name: string, punct: string = "!") -> string => strcat(name, punct)
```

**This is a new *language* feature, not just syntax.** json-fn has **no
parameter defaults today** (grammar `param := ident | "..." ident | objectPattern`).
Shipping it requires:

- an **encoding in the body** for the default (candidate: a `$defaults` sibling
  keyed by param name, or richer `$params` slots),
- **evaluator support** to substitute the default when the arg is missing/null,
- propagation to all four interpreters + shorthand parser/printer + spec cases.

**Plan:** treat defaults as a **standalone runtime proposal**, sequenced *before*
this type-syntax feature (the type side is then trivial: the param's schema is
its base type, the default is a runtime concern). When we design the default
encoding, keep the type-syntax needs in mind so `= <literal>` slots in cleanly.
Do not block the v1 type spec on it.

---

## 5. Standalone / bodyless signature declarations

The `type-sketch.md` §7 `.d.ts`-style form:

```jfn
fn pieceColor(piece: Cell) -> Color | null
fn playMove(state: State, from: integer, to: integer) -> State
```

**Deferred / likely unnecessary.** In v1 every user function is
`name: (typed params) -> Ret => body`; the `fn ...` form was just a compact way to
*list* signatures in the sketch. Host/external functions are **injected** by the
host (`BuiltinTable`), not declared in-module, so there's no v1 need for a
bodyless form. Revisit only if a use case appears (e.g. authoring `.d.ts`-style
declaration files for host capability surfaces).

---

## 6. `->` token disambiguation

`->` currently does triple duty: **return type**, **function-type arrow**, and
**cond/match arm**. All three are positionally unambiguous today, but if it reads
poorly at scale we may give one of them a distinct token. Cosmetic; iterate after
v1 is in hand.

---

## 7. Narrowing vs. the assertion operator (spelling only)

The assertion operator itself is **in v1** (§5 of the reference decisions). What's
deferred is finalizing:

- **spelling** — `x!` (recommended) vs `x!!` vs `assert(x, T)`;
- **runtime semantics** — whether `!` lowers to an actual runtime-check AST node
  (recommended: yes, so the assertion fails loudly if wrong, matching
  "types are validators") or is checker-only metadata.

Once real flow-narrowing coverage is assessed against actual modules, revisit
whether the operator is needed often enough to warrant sugar, or whether the
existing `$cond`/`$if`/`$match` narrowing (`typescript/src/check/narrowing.ts`)
already covers the compute-then-branch idiom.
