# Testing builtins

The files under `spec/cases/builtins/` test builtins directly. Validate each
file against `spec/cases/builtin.schema.json` before running it.

Each file must be exactly one category directory below
`spec/cases/builtins/`. Its file name must match its `builtin` field, and both
the builtin and category must match the builtin registry.

## Running a case

Create a fresh test harness for every case, decode its `args` as described by
the schema, and invoke the named builtin directly. The adapter should call the
same builtin code used during normal evaluation, but should not evaluate a
wrapper program merely to reach it.

Callable fixtures are adapter values:

- `$callback` is a scripted callback. Consume its steps in order, compare every
  call's arguments for exact JSON equality, and apply the step's outcome. Extra
  calls and unconsumed steps fail the case.
- `$builtin` is an opaque callable reference to the named builtin.
- `$function` registers the supplied language function and provides a callable
  reference to it.

Fixture state, registered functions, logs, and meter data must not carry
between cases.

## Checking the result

For `returns`, compare the returned value using exact structural JSON equality.
For `throws`, require an error whose message contains `messageIncludes`.

After invocation, including an expected error, verify that every scripted
callback step was consumed.

When observations are present, compare only the fields given by the case:

- `logs` is the exact ordered sequence of logger calls.
- `meter.charged` is the total amount charged.
- `meter.guardedSizes` is the exact ordered sequence of guarded sizes.

Any fixture mismatch is a test failure rather than a builtin error.
