# Recenter — per-priority overviews

Expansions of the work areas in [`../recenter-plan.md`](../recenter-plan.md).
Each doc is an *overview*: what needs to happen for that area to land and which
files it touches — not a detailed implementation plan.

| Doc | Recenter §  | Summary |
| --- | --- | --- |
| [priority-1-kill-silent-degradation.md](priority-1-kill-silent-degradation.md) | §2 | Turn silent `→ any` paths into hard errors or counted coverage diagnostics |
| [priority-2-bidirectional-diagnostics.md](priority-2-bidirectional-diagnostics.md) | §3 | Make `check()` recurse structurally; add `--json` structured diagnostics |
| [priority-3-narrowing-and-assertion.md](priority-3-narrowing-and-assertion.md) | §4 | Freeze narrowing, fix the one bug, ship `x!`, collapse the warning tier |
| [signature-precision.md](signature-precision.md) | §5 | Tighten `fromEntries`-family signatures; `T \| null` over sentinels |
| [effects-handle.md](effects-handle.md) | §6 | Annotated `handle` boundary validation with explicit totality/bubbling semantics |
| [builtin-polymorphism-and-effects.md](builtin-polymorphism-and-effects.md) | §5–6 | Separate builtin polymorphism, operator effect contracts, task indexing, and guest generics |
| [smaller-fixes.md](smaller-fixes.md) | §7 | `where` parsing, index/render ergonomics, refinement UX note |

## Suggested sequencing (from recenter-plan §8)

1. Priority 1: dangling-`$ref` + missing-field errors + `requireTypedModuleFunctions` default.
2. Priority 3: `factsFromCondition` fallback bug + `match` narrowing.
3. Priority 2: bidirectional check-mode + `--json` diagnostics.
4. Priority 3: `x!` parse + runtime cast; then warnings→errors flip.
5. §5 signature templates; §6 annotated `handle`.
6. Priority 1 coverage reporting; §4 narrowing spec + table tests.

Success criterion: `examples/typed/ledger.jfn` and `examples/typed/thermostat.jfn` check
clean without their `-checked` cousins' restructurings (modulo explicit `!`),
and a fully-`any` module no longer reports `No type errors` without also
reporting what it didn't check.
