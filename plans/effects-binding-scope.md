# Plan: clarify the scope of the `effects` binding

Status: **proposed documentation correction.**

Document `effects` as reserved only in modules linked to an environment
contract. Do not change the current linker behavior.

## Current behavior

`Task` and `effects` have different reservation rules:

- `Task` is always reserved as a user-declared type name. The shorthand parser
  enforces this in
  [`typescript/src/shorthand/parser.ts`](../typescript/src/shorthand/parser.ts).
- `effects` is reserved as a top-level value binding only when an environment
  contract is present. The linker rejects a collision and then injects the
  contract's effect namespace in
  [`typescript/src/module-linker.ts`](../typescript/src/module-linker.ts).
- An unlinked module may define a top-level `effects` binding because no
  namespace is injected.

This contract-scoped behavior is intentional and already described correctly
in
[`docs/environment-contract.md`](../docs/environment-contract.md) and
[`docs/language.md`](../docs/language.md).

## Documentation issue

[`docs/writing-jfn.md`](../docs/writing-jfn.md) §3 correctly qualifies
injected names with "if the module is linked against an environment contract."
The effects introduction and trip-up checklist later describe `effects` as
reserved without consistently repeating that condition. This can be read as a
global parser rule like the reservation of `Task`, which it is not.

## Changes

1. In `docs/writing-jfn.md` §12, qualify the effect-namespace explanation:

   > In a contract-linked module, the environment injects `effects`, so the
   > module may not declare that name as a top-level binding.

2. In the §13 trip-up checklist, replace the combined reserved-name statement
   with:

   > `Task` is reserved as a type name. In a contract-linked module, `effects`
   > is injected by the linker and may not be declared as a top-level binding.

3. Search the remaining documentation for unconditional descriptions of
   `effects` as a reserved module binding and add the contract-linked
   qualification where needed. Do not weaken rules concerning contract entry
   names or contract-owned definitions.

4. Keep the implementation unchanged. Existing linker tests should continue
   to cover rejection of a contract-linked collision. Add a focused unlinked
   module check only if that allowed behavior is not already protected by a
   test.

## Non-goals

- Reserving `effects` in every module.
- Renaming the injected namespace.
- Changing effect construction, linking, or runtime behavior.
- Changing the unconditional reservation of the `Task` type name.

## Acceptance criteria

- Every user-facing reserved-name statement distinguishes the unconditional
  `Task` type rule from the contract-scoped `effects` binding rule.
- Documentation remains consistent with
  `typescript/src/module-linker.ts`: unlinked `effects` is allowed and a linked
  collision is rejected.
- Existing documentation and TypeScript checks pass.
