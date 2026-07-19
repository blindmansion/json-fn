# Environment entry return consistency

Status: proposed.

## Summary

Environment entry contracts intentionally support two return modes:

- `returns: Schema` describes a direct entry result.
- `returns: { task: Schema }` describes a task whose eventual completion value
  matches `Schema`.

The environment types, validator, and checker preserve this distinction, but
the host runtime does not. `runTask` unconditionally sends every entry result
to `stepTask`, so a valid direct entry passes `jfn check` and then fails under
`jfn eval --environment` with `Task expected`.

Development evaluation can hide the mismatch. `--function <name>` calls the
selected function directly and deliberately bypasses the production entry
contract and host trampoline. A demo can therefore succeed even when the
declared entry cannot run.

## Decision

Complete the existing two-mode design rather than removing direct entries.

The explicit `EntryReturn = Schema | { task: Schema }` API, `isTaskReturn`,
`entryReturnType`, and `entryCompletionType` already model both modes. The
checker also checks each mode correctly. Supporting direct execution is the
smallest change and preserves an intentional public contract shape.

Keep `--function` as a development escape hatch, but document plainly that it
does not validate or execute the environment entry contract.

## Current inconsistency

For a direct entry:

```json
{
  "entry": {
    "name": "main",
    "required": [],
    "optional": [],
    "returns": { "type": "integer" }
  }
}
```

this module is accepted by the checker:

```jfn
{ main: () => 42 }
```

Normal environment evaluation then calls `stepTask(42, ...)` and fails. By
contrast, the task form correctly requires and executes:

```json
"returns": { "task": { "type": "integer" } }
```

```jfn
{ main: () => pure(42) }
```

## Implementation plan

### 1. Branch host execution by the declared return mode

Update `typescript/src/host/run-task.ts` to inspect
`isTaskReturn(environment.entry.returns)` after preparing the environment and
validating arguments.

- For a task return, preserve the current trampoline exactly: invoke the entry,
  repeatedly call `stepTask`, dispatch capabilities, and validate the eventual
  completion value.
- For a direct return, invoke the entry once through the prepared evaluator and
  validate that immediate result against the declared schema. Do not call
  `stepTask` and do not interpret task-shaped data accidentally returned by a
  direct entry.

Refactor the shared setup so both paths use the same runtime module, merged
definitions, registry, limits, argument validation, and final
`enforceRuntimeContract` boundary. Avoid preparing the evaluator twice.

Retain the public `runTask` export for compatibility even though it will now
execute either environment entry mode. A broader API rename is unnecessary for
this fix.

### 2. Preserve the task-only capability boundary

Direct entries may call direct host functions, but effects still produce tasks.
The checker should continue rejecting a task-valued body against a direct
return schema. Do not auto-run a task merely because the immediate value happens
to be task-shaped; execution mode comes from the operator-owned contract.

This keeps effect handling explicit and prevents a guest value from changing
the host's execution policy.

### 3. Add checker/runtime parity tests

Extend `typescript/test/environment.test.ts` with:

1. a direct integer entry that checks and evaluates to its integer;
2. a direct entry whose runtime result violates its schema;
3. a direct contract paired with a task-valued body, rejected by the checker;
4. a task contract paired with a direct body, rejected by the checker;
5. the existing task execution path, including an effect, as a regression;
6. direct and task entries with required and optional arguments;
7. a direct entry returning ordinary object data that resembles neither a task
   nor a function.

Add CLI coverage in `typescript/test/cli-eval.test.ts` proving that:

- `eval --environment` executes both declared modes correctly;
- `eval --environment --function demo` remains direct development evaluation;
  and
- success under `--function` does not imply that the production entry was
  invoked.

### 4. Clarify the language and CLI documentation

Update the environment section of `docs/language.md` to define both return
forms side by side:

- plain schema: immediate result, validated directly;
- `{ task: A }`: task trampoline, capabilities, and validated completion.

State that `--function` injects environment definitions and generated effects
but bypasses entry argument validation, entry return validation, and automatic
task execution. Recommend testing an environment module at least once without
`--function`.

Update CLI help text to call `--function` an unchecked development invocation,
without making the concise option summary substantially longer.

### 5. Verify the example workflow

Add or adapt a small fixture with a pure direct entry, then run:

```bash
cd typescript
bun run check
bun test
bun run src/cli.ts check --environment <environment> --file <module>
bun run src/cli.ts eval --environment <environment> --file <module>
```

Keep effectful examples task-returning. Pure examples may use direct entries
once runtime support lands; they should not need `pure(...)` solely to satisfy
the host trampoline.

## Acceptance criteria

- Every environment accepted with a direct entry return can execute through the
  normal environment runtime without `Task expected`.
- Direct and task entry modes agree between environment validation, static
  checking, CLI execution, and the public host API.
- Runtime result contracts are enforced in both modes.
- Existing task/effect behavior and serialized task semantics are unchanged.
- Documentation makes the production-entry versus `--function` distinction
  explicit.

