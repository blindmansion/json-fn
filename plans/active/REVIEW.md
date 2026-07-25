# json-fn — issues found during exploratory review

Reviewed at: `blindmansion/json-fn` @ `main`, 2026-07-23. All testing done against the
canonical TypeScript implementation (`typescript/`, bun 1.3.14). Baseline health was
excellent: `bun test` passes 1954/0, `bun run check` is clean, and every bundled example
evaluates and typechecks with complete type coverage. The issues below are the daylight
I could find between the docs and the implementation, plus ergonomic problems that
survived a docs-vs-behavior cross-check.

Severity legend: **High** = likely to mislead or block a real user; **Medium** =
ergonomic papercut with a workaround; **Low** = polish / documented-but-lossy.

---

## 1. `x != null` / `x == null` does not narrow — Resolved

Resolved by treating `null` as a category-exact exclusion in equality narrowing:
excluding it now removes a primitive `null` union arm while all other broad-literal
exclusions retain the frozen conservative behavior.

The most common null-guard idiom from JS/TS silently fails to discharge nullability:

```jfn
// ERROR: {"anyOf":[{"type":"integer"},{"type":"null"}]} is not assignable to {"type":"integer"}
guard: (x: integer | null) -> integer => if x != null then x else 0
```

while all of these work:

```jfn
guardIsNull: (x: integer | null) -> integer => if isNull(x) then 0 else x
guardTruthy: (x: integer | null) -> integer => if x then x else 0     // (drops 0 into else, fine here)
guardBang:   (x?: integer) -> integer => x!
```

**Why:** per `docs/narrowing.md` (frozen), equality narrowing form 3 excludes a literal
only via enum/const membership surgery, which is "a no-op for a subject with no finite
literal set". `integer | null` has no finite literal set, so `!= null` yields no fact —
even though `null` is exactly representable as a type and the subtraction is trivially
expressible.

**Impact:** the narrowing spec is explicitly frozen, so this may be working as intended,
but it is the number-one idiom every newcomer (human or model) will reach for, and the
resulting diagnostic is a bare assignability error with no hint that `isNull(x)`, `x!`,
or truthiness are the sanctioned forms.

**Suggested fix (pick one):**

- carve out `null` as an always-excludable "literal" in form 3 (it is a full JSON type,
  not just a const, so the remainder is always representable); or
- keep the frozen semantics but special-case the diagnostic: when an `eq/neq`-with-`null`
  condition governs the failing branch, append "note: `== null` / `!= null` does not
  narrow; use `isNull(x)`, truthiness, or `x!`".

Repro:

```bash
cd typescript
printf '{ h: (x: integer | null) -> integer => if x != null then x else 0 }' | bun run src/cli.ts check
```

---

## 2. Unknown callee names are not check errors — Resolved

Resolved by making a literal callee name that is absent from both the lexical
scope and merged callable registry a hard `Unknown function` error. Arguments
are still checked for independent diagnostics, and the failed call recovers as
`never` to avoid a misleading downstream assignability error. Dynamic callees
retain the existing visible-`any` degradation path.

An unresolved name in call position degrades to `any` with an `info` diagnostic instead
of erroring. A typo'd builtin passes `check` with exit 0 whenever the result does not
flow into a constrained position:

```bash
$ bun run src/cli.ts check --expr 'nonexistent(1)'
type: true
info: <root>: expression degraded to `any` because the callee has no known function type.
0 errors.        # exit code 0
```

Same for plausible-but-wrong builtin names (`len`, `first` — the real names are
`length`, `head`). Evaluation of the same expression always fails at runtime
(`Unknown function: nonexistent`), so the checker is passing programs that can never
run.

When the degraded result _does_ flow into a typed position, you get an error — but it is
a misleading downstream assignability failure (`true is not assignable to
{"type":"integer"}`) rather than "unknown function".

**Suggested fix:** a literal callee name that resolves in neither the lexical scope nor
the merged registry should be a hard error (the runtime has no fallback either).
Dynamic callees (`(expr)(...)`) can keep the degradation path.

---

## 3. Builtin function references don't resolve in the checker — Resolved

Resolved by typing unshadowed `$fn` and bare-name registry references as
first-class function values. Callback context now selects compatible overloads
and instantiates callable type parameters; directly invoked references use the
normal callable dispatcher. Lexical and module bindings continue to shadow
registry names.

`&`-references (and bare-name value fallbacks) to **builtins** are "unresolved" for the
checker, degrade to `any`, and then cause spurious downstream errors — even though the
runtime evaluates them fine and `docs/shorthand-spec.md` §4 explicitly promises
`map(length, xs)` == `map(&length, xs)`:

```bash
$ cat > /tmp/mod.jfn <<'EOF'
{ viaBuiltin: () -> string[] => map(&upper, ["a", "b"]) }
EOF
$ bun run src/cli.ts check --file /tmp/mod.jfn
info: viaBuiltin.$return.$args[0]: expression degraded to `any` because function reference "upper" is unresolved.
error: viaBuiltin.$return: {"type":"array","items":true} is not assignable to {"type":"array","items":{"type":"string"}}.

$ bun run src/cli.ts eval --file /tmp/mod.jfn --function viaBuiltin
["A","B"]        # runtime is fine
```

References to module-defined functions resolve correctly (`map(&double, ...)` with a
typed module `double` checks clean), so this looks like a missing builtin-table lookup
in the `$fn` / bare-reference checker path. Monomorphic builtins (`upper`) fail the same
way as polymorphic ones (`length`), so it is not just a typeParams limitation.

**Impact:** point-free style with builtins is either a false type error (typed module)
or silent coverage degradation (untyped position). The workaround — eta-expanding to
`map((s) => upper(s), xs)` — works and checks clean, but contradicts the shorthand
spec's own guidance.

---

## 4. The surface syntax can express programs the evaluator rejects (`&(array)`) — Resolved

Resolved by rejecting literal-array operands while parsing `&(...)` and rejecting
array-valued `$fn` nodes before the shorthand printer renders any part of the tree.
Dynamic function-reference operands remain supported, and raw JSON islands remain
opaque. The invalid `AGENTS.md` example now demonstrates a canonical `$call` instead.

`docs/language.md`: "`$fn` is never an array — an array `$fn` is a pre-split artifact
and is rejected." The evaluator enforces this. But:

- `to-shorthand` accepts the invalid canonical JSON and prints it:

  ```bash
  $ echo '{ "$fn": ["add", 1, 2] }' | bun run src/cli.ts to-shorthand
  &(["add", 1, 2])
  ```

- and that shorthand parses right back to the rejected JSON:

  ```bash
  $ bun run src/cli.ts to-json '&(["add", 1, 2])' -c
  {"$fn":["add",1,2]}
  $ echo '{"$fn":["add",1,2]}' | bun run src/cli.ts eval --json-input
  jfn: evaluation error: ... Function references ($fn) cannot be arrays ...
  ```

So `&(<array literal>)` is a parseable spelling of an always-invalid program, and the
printer will happily launder invalid JSON into plausible-looking shorthand.

**Compounding doc bug:** `AGENTS.md`'s own `to-shorthand` example pipes exactly this
invalid value (`echo '{ "$fn": ["add", 1, 2] }' | ... to-shorthand`), so the repo's
agent-facing quickstart demonstrates an unevaluable program.

**Suggested fix:** reject array `$fn` in the printer and in `&(...)` lowering when the
operand is a literal array (dynamic operands that _evaluate_ to arrays already fail at
runtime), and fix the AGENTS.md example to something evaluable, e.g.
`{ "$fn": "double" }` or an `add(1, 2)` call.

---

## 5. Contract-boundary errors have no failure path — Medium

Boundary validation failures print the entire top-level schema with no pointer to the
failing argument, field, or index:

```bash
$ bun run src/cli.ts eval --file ../examples/dungeon.jfn \
    --contract ../examples/dungeon.contract.json --args '[{"at":"attic","held":[]}]'
jfn: evaluation error: entry "play" arguments contract failed: value does not satisfy
{"type":"array","prefixItems":[{"$ref":"#/$defs/PlayerState"}],"items":false,"minItems":1}
```

The actual problem (`"attic"` is not in the `Room` enum, one field deep inside
`$defs/PlayerState`) is invisible; with a realistic contract the printed schema is a
wall of refs. The environment-contract doc emphasizes "stable error code/path
classification" for _structural_ contract validation — the same treatment (an
instance path like `args[0].at: "attic" is not one of ["cell","hall","gate"]`) would
make boundary failures debuggable. This applies to entry args, effect args/results, and
`$as` ascription failures alike.

---

## 6. `$comment` is lossy through the shorthand printer — Low (documented, but undermines a pitch)

`docs/language.md` pitches `$comment` as surviving `parse → transform → stringify`,
which is true for JSON. But the canonical printer silently drops it:

```bash
$ echo '{"$comment": "keep me", "$call": "add", "$args": [1, 2]}' | bun run src/cli.ts to-shorthand
1 + 2
```

so any JSON → `.jfn` → JSON pipeline destroys comments. Shorthand comment attachment is
the acknowledged 🔴 TODO(comments) in `shorthand-spec.md` §1/§12, but until it lands,
`to-shorthand` is not a safe canonicalization step for commented programs — worth a
warning in the CLI help or docs. (`//` comments in `.jfn` input are likewise discarded
on `to-json`, per the same TODO.)

---

## 7. Degraded `any` is inconsistently gradual — Low (design observation)

The two halves of the degradation story pull in opposite directions:

- an _unconstrained_ degraded expression is silent success (issue 2), but
- a _constrained_ degraded expression is a hard error, because `any`/`items: true` is
  **not** assignable to a concrete expected type
  (`true is not assignable to {"type":"integer"}`).

So degradation is forgiving exactly where being strict would catch real bugs (typos in
unconstrained positions) and strict exactly where the user can do nothing about it
without restructuring (e.g. issue 3's builtin refs, or the documented `apply`/spread
imprecision feeding a typed return). If the assignability rule is intentional
(soundness-first — reasonable), issues 2 and 3 become more important, since they are the
main sources of unwanted `any` in otherwise fully-typed modules.

---

## 8. Minor notes

- **README is out of date** — already acknowledged in AGENTS.md; noting for completeness
  since it is the first file a visitor reads. The pitch examples there predate module
  scope and the current CLI.
- **Printer parenthesizes method-call callees** — `(caps.db.query)(sql)`,
  `(makeCountdown(42))(3)`. Round-trips correctly; already tracked as 🟡 deferred polish
  in `shorthand-spec.md` §12.
- **`bun.sh` install script** was unreachable from this sandbox (HTTP 403 on
  `https://bun.sh/install`) — environment-specific, but `npm install -g bun` worked and
  might be worth mentioning in AGENTS.md as a fallback.

---

## What was checked and found solid (no issues)

For contrast, these areas were probed and matched the docs exactly: refinement opacity
(`Score + 1` errors until `as Score`); unreachable-`$match`-case and non-contractive
type diagnostics; `Task` reserved at parse; module functions requiring full signatures;
contextual callback arity (`map` vs `mapIndexed`); the `isInteger` narrowing table;
discriminated-union narrowing via `match`/`cond`/boolean-discriminant truthiness;
`$match` scalar-subject enforcement; property-access rules (missing key → `null`,
traversal into `null` → error, no key coercion); structural equality with no coercion;
NaN/Infinity rejection (`1/0`, `pow(10,400)`, `300!`); circular-dependency detection and
its exact message; fuel / value-size / call-depth limits via CLI flags; closure capture
by substitution and escaping closures carrying local functions; typed effects end to end
(manifest arg checking, `Task<A>` flow through `do`/`bind`, annotated total `handle`);
multi-shot `resume`; serializing a continuation in one process and resuming it in
another; `runTask` boundary validation (entry args, effect results, `TaskRaiseError`
payloads, unknown-effect rejection); `analyzeDeploymentCapabilities` uncovered-effect
reporting; and the durable driver's suspend / new-driver-resume / bad-completion →
terminal `"contract"` failure lifecycle.
