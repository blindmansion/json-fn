# Typed callable and host environment roadmap

## Goal

Give an agent a complete, operator-owned description of the code it can write:
core builtins, host-provided functions, effect capabilities, shared named types,
and the required entrypoint. Ordinary callable types remain portable data.
Typing that depends on call structure, callback flow, or host policy uses an
explicit host-language rule with a portable fallback.

The declared contracts are the typed public API. A runtime implementation may
defensively accept additional values, but agent-authored programs may rely only
on behavior represented by the contracts and language documentation.

## Workstreams

### 1. Correct the current HOF contracts

See [hof-type-corrections.md](hof-type-corrections.md).

Status: the contract-cleanup delivery slice is complete. `groupBy` and the
HOF/runtime and coverage documentation are aligned; `reduce` validation and
the rule-dependent `flatMap` correction remain as later slices.

Resolve known drift before using the current builtin table as the model for
host-authored contracts:

- align `groupBy` with its documented numeric-key behavior;
- make `flatMap` typing match its scalar-or-array runtime contract;
- close the stale accumulator-context gap in `reduce`;
- document intentional static/runtime differences and callback limitations; and
- clarify that full type coverage means no fallback to `any`.

The small documentation and `groupBy` fixes can land immediately. `flatMap`
should prove the extensible rule mechanism rather than grow the data dialect
solely for conditional one-level flattening.

### 2. Establish portable callable contracts and injectable rules

See [callable-contracts.md](callable-contracts.md).

Normalize builtin and host-function declarations around:

- validated portable fallback signatures;
- an optional namespaced type-rule identifier;
- an injected host-language rule registry; and
- explicit merging of core and host callable contracts.

This replaces the current split among overload arrays, hardcoded rule floors,
and hidden name-based return refinements. It is the prerequisite for hosts to
add complex HOFs without making the JSON signature language substantially more
powerful.

### 3. Build the typed host environment

See [host-environment.md](host-environment.md).

The existing host-environment work remains the main delivery track:

1. unify checker/runtime definition pools;
2. add the callable-contract/rule substrate;
3. add an effect manifest and checker-internal `Task<A>`;
4. package named types, direct host functions, effects, and the entry contract
   into one operator-owned environment;
5. migrate the typed examples; and
6. build the durable orchestration driver on the same manifest.

Effect arguments/results and entry boundaries reuse
`typescript/src/runtime-contract.ts`. Capability functions do not own schemas;
the environment is the contract consumed by both checker and runtime.

## Dependency order

```text
HOF docs + groupBy ───────────────────────────────────────────────┐
                                                                 │
B1 unified defs ─> callable contracts/rules ─┬─> effect manifest ├─> environment + entry ─> examples
                                             ├─> Task<A> ────────┘
                                             └─> flatMap rule

reduce final-context validation   (independent correctness track)
durable orchestration driver      (parallel, manifest-dependent track)
```

## Recommended delivery slices

1. **Contract cleanup — ✅ done:** `groupBy`, HOF/runtime documentation, and
   coverage wording.
2. **Definition-pool unification — ✅ done:** checker and runtime now share
   builtin < environment < module definition precedence.
3. **`reduce` validation:** focused checker change with no callable-format
   refactor.
4. **Callable table validation:** make malformed operator contracts fail at
   load time.
5. **Rule substrate:** fallback signatures, injected rule registry, and
   migration of existing core special cases.
6. **`flatMap` rule:** first precision rule implemented on the new substrate.
7. **Effects and `Task<A>`:** host-environment B2/B3.
8. **Environment packaging:** direct functions, effects, types, and entrypoint
   in host-environment B4.
9. **Examples and durability:** B5 and B6.

Behavior corrections should not be mixed into the rule-substrate refactor
except for `flatMap`, whose purpose is to exercise that substrate. This keeps
regressions attributable and makes each slice independently reviewable.

## Completion criteria

- Agents receive one environment containing every callable and effect contract
  they may use.
- `jfn check --require-full-coverage` reports no silent dynamic seams in a
  fully configured environment.
- Core and host contracts use the same validated data format.
- A complex HOF can ship a portable fallback plus a host-language type rule.
- Missing rule implementations visibly degrade to the fallback rather than
  silently claiming precise coverage.
- Checker and runtime resolve every `$ref` against the same definition pool.
- Runtime boundaries validate direct host calls, effects, and entry arguments
  against the operator-owned environment where their contracts are tractable.
