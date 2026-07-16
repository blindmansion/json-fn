# Higher-order builtin type corrections

## Goal

Make the current higher-order builtin contracts sound, faithful to documented
language behavior, and predictable for agent authors before those contracts
become the model for operator-provided functions.

This work does not add guest generics or attempt precise typing for `pipe` and
`apply`. Complex call-dependent typing belongs in the rule mechanism described
in [callable-contracts.md](callable-contracts.md).

## Contract policy

The builtin signature table and language documentation define the typed public
API:

- documented and conforming calls must be accepted by the checker;
- runtime permissiveness beyond the declared contract is not automatically part
  of the typed API;
- result types may be conservative but must remain sound; and
- a builtin whose public behavior cannot be represented honestly by a data
  signature should use a code rule with a portable fallback.

This distinguishes real contract drift from intentional runtime tolerance.

## C1 — `groupBy` numeric keys — ✅ done

### Problem

`docs/language.md` and `spec/cases/higher-order-2.json` allow a key callback to
return a string or number. `typescript/src/stdlib.ts` accepts both and converts
the result to a string object key. `spec/builtins.json` currently accepts only a
string callback return.

### Work

- Change the `groupBy` callback return in `spec/builtins.json` to
  `string | number`, matching `sortBy`.
- Keep the result type `{ [string]: T[] }`; JSON object keys remain strings.
- Add a numeric-key checker test to
  `typescript/test/check/builtins.test.ts`.
- Document numeric-key stringification in `docs/language.md` and, where useful,
  `docs/builtin-signatures.md`.

### Acceptance

`groupBy((n) => mod(n, 2), [1, 2, 3])` is fully checked and returns a
string-keyed map of integer arrays.

Implemented by widening the portable callback return contract to
`string | number`. The runtime and conformance case were already correct; the
checker regression now covers both string and numeric key callbacks. No
checker-engine special case was needed.

## C2 — `flatMap` scalar-or-array returns — ✅ done

### Problem

The runtime and conformance suite explicitly retain scalar callback results as
single output elements and flatten array results by one level. The current
signature requires `U[]` and rejects a scalar `U`.

This is not a safe one-line overload change. The overload chooser defers bare
lambda returns, so two callback-return overloads cannot currently select the
right arm. The template matcher also does not infer a `$tvar` through alternative
template arms.

### Work

Implement `flatMap` as the first precision rule on the substrate from
[callable-contracts.md](callable-contracts.md):

- portable fallback: contextually expose `(T, integer)` and return `any[]`;
- precise `core.flatMap` rule: synthesize the callback result and compute the
  one-level flattened element schema;
- array arms contribute their item schema;
- scalar arms contribute themselves;
- union callback returns distribute across those cases.

Likely files:

- `spec/builtins.json`
- `typescript/src/check/builtin-types.ts`
- `typescript/src/check/builtin-rules.ts`
- `typescript/test/check/builtins.test.ts`
- `spec/cases/higher-order-2.json`
- `docs/language.md`
- `docs/builtin-signatures.md`

### Acceptance

- callbacks returning `U`, `U[]`, or a union of both infer a sound result array;
- callback parameters remain contextually typed from the input array;
- the existing array-return cases retain their precision; and
- the scalar conformance case is accepted by both evaluator and checker.

Implemented with an `any[]` portable fallback and a registered `core.flatMap`
rule. The rule contextually synthesizes bare callbacks, reads declared returns
from concrete callbacks, and distributes one-level flattening across array,
tuple, scalar, reference, literal, and union schemas. Missing-rule checking
retains the fallback and reports a coverage degradation.

## C3 — Final accumulator validation for `reduce` — ✅ done

### Problem

Repeated `$tvar` occurrences intentionally join, so `reduce` may widen
accumulator `U` using both the initializer and callback return. A bare callback
is initially checked under the pre-widened `U`, however, and is not checked
again after its return finalizes that variable. Later runtime iterations may
therefore pass an accumulator type the callback body was never checked against.

### Work

Keep this separate from the callable-rule refactor:

1. infer concrete argument bindings and contextually synthesize the callback as
   today;
2. finalize the joined binding environment;
3. recheck any callback whose return changed a variable occurring in its
   parameter types under the final instantiated function type;
4. treat that pass as validation only—do not widen bindings again; and
5. emit a callback-local diagnostic if the final accumulator type is unsafe.

If this proves unstable or difficult to explain, make an explicit language
decision to require a stable accumulator type instead. Do not accidentally
change the policy as a side effect of generic unification work.

Likely files:

- `typescript/src/check/builtin-rules.ts`
- `typescript/src/check/subsumption.ts`
- `typescript/test/check/builtins.test.ts`
- `docs/builtin-signatures.md`

### Acceptance

- ordinary same-type reductions remain precise;
- an accumulator union is accepted only when the callback is valid for every
  accumulator type it may receive;
- invalid changing-accumulator callbacks produce an error rather than a
  fully-checked union; and
- named/annotated callback arity policy is unchanged.

Implemented as a validation-only second pass for contextual callbacks whose
return changes a type variable also used by their parameter types. The callback
is synthesized under the final joined bindings and its return is checked
without feeding new information back into inference. Existing same-type
reductions remain precise, safe accumulator unions are accepted, and unsafe
widening is diagnosed inside the callback.

## C4 — Documentation and diagnostic clarity — ✅ done

### Intentional behavior to document

- `reReplaceWith` callbacks statically return `string`; the runtime defensively
  applies `String()` to other values.
- Bare contextual lambdas may omit trailing builtin-supplied arguments.
- Named and annotated callbacks currently use strict function arity; wrapper
  lambdas are the typed workaround.
- Runtime string callback names are not currently resolved by the checker.
  Inline lambdas and typed `&name` references are the canonical typed forms.
- `mapValues` returns the honest map floor `{ [string]: U }`; exact input keys
  are not preserved statically.
- `filter` and `find` do not derive type predicates from callback logic.

### Coverage wording

The CLI's coverage result measures fallback to `any`, not absence of errors or
maximal precision. Prefer wording such as:

```text
Type coverage: complete (no dynamic degradations).
```

Keep `--require-full-coverage` as the agent-facing gate: an information-level
degradation means the checker could not prove that part of the program.

Likely files:

- `typescript/src/cli.ts`
- `typescript/test/cli-check.test.ts`
- `docs/language.md`
- `docs/builtin-signatures.md`
- stale type-checking notes under `plans/` and `todo/`

The language and builtin-signature references now document the intentional
static/runtime boundaries above. CLI output uses `Type coverage: complete (no
dynamic degradations).` or an incomplete summary with the degradation count;
the exit policy and `--require-full-coverage` behavior are unchanged.

## Non-goals

- Precise `pipe` or `apply` typing.
- General relaxation of function arity.
- Typing string names as first-class builtin function values.
- Exact key preservation for `mapValues` or `groupBy`.
- Predicate-driven narrowing for `filter` or `find`.
- `Task<A>` and effect continuation typing; those belong to
  [host-environment.md](host-environment.md).

## Delivery order

1. `groupBy` and documentation/coverage clarification. ✅ done
2. `reduce` final-context validation as an independent checker change. ✅ done
3. Callable-rule substrate from `callable-contracts.md`.
4. `flatMap` precision rule as the first substantive consumer. ✅ done

## Handoff notes

- C3 (`reduce`) is complete and did not change the callable contract format.
- The callable-rule substrate, load-time contract validation, and C2
  (`flatMap`) precision rule are complete.
