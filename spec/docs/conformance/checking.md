# Testing type checking

The files under `spec/cases/check/` test the observable behavior of the type
checker on canonical json-fn expressions and modules. Validate each file
against `spec/cases/check.schema.json` before registering any of its cases;
malformed fixtures must fail before tests run.

Suites live directly below `check/` or exactly one directory level deeper. A
suite's `$schema` must spell the depth-exact relative path to the schema —
`../check.schema.json` directly below `check/`, `../../check.schema.json` one
level deeper. Loaders must verify that exact value, not merely accept a
plausible string. The optional `comment` fields are maintenance notes and do
not affect execution.

## Inputs

Each case checks exactly one of:

- `expression` — a canonical json-fn expression, checked through the
  standalone-expression entry point. It may carry `defs`, a pool of named
  schema definitions in scope during checking.
- `module` — a canonical json-fn module, checked through the module entry
  point. It may carry `contract`, a portable environment contract.

Inputs are canonical JSON, never shorthand source. Pass a case's `contract`
through the implementation's ordinary checker/linker entry point; do not
reconstruct contract behavior inside the test adapter.

## Builtins and options

The required `builtins` field selects the callable table:

- `standard` — load the portable registry from `spec/builtins/builtins.json`.
- `none` — provide no builtin callable table.

A case-level `builtins` overrides the suite value. Fixtures never embed
implementation-owned callable tables or type rules.

The portable `options` object currently supports only
`allowUntypedFunctions`, which permits module-level functions without declared
signatures and records the loss of coverage as an information diagnostic
instead of an error. Full-coverage policy is not an option: consumers derive
it from the presence of `info` diagnostics.

## Expected outcomes

An ordinary case carries `expected` with a required `diagnostics` array — the
complete expected diagnostic multiset. An empty array requires checking to
produce no diagnostics at all.

Expression cases may also assert `type`, the inferred schema, compared by
exact structural JSON equality. JSON object member order is not part of this
comparison. Validity is derived — a case is a failure case exactly when its
diagnostic set contains an `error` — and coverage degradation is represented
by `info` diagnostics; there are no separate `valid` or `coverage` fields.

## Diagnostic matching

Compare diagnostics as an unordered multiset: each expected matcher must
consume exactly one actual diagnostic, and every actual diagnostic must be
consumed by exactly one matcher. Missing, duplicate, and additional
diagnostics are all test failures. Ignoring order keeps implementation
traversal order non-normative without weakening the assertion.

Within one matcher:

- `path` and `severity` are exact. `path` is the canonical JSON path of the
  diagnostic as string segments; `severity` is `error` for a definite type
  failure or `info` for visible loss of type coverage.
- `messageIncludes` is a substring assertion on the diagnostic message.
- `expected` and `actual`, when present, are exact structural JSON assertions
  on the schemas attached to the diagnostic.

There is no partial-list or allow-additional mode. If implementations
legitimately disagree about whether a diagnostic is required, resolve the
language-design question rather than weakening the fixture.

## Portable throws

The checker reports malformed programs through diagnostics and continues. A
`throws` outcome is reserved for failures outside recover-and-continue
checking, such as exceeding the fixed structural-depth limit. Its
`messageIncludes` is a substring assertion on the implementation's ordinary
error message; do not require a particular exception class.

## Fixed limits

Structural-depth cases exercise the fixed language limit, not a configurable
runner budget. Run their concrete committed JSON like any other case; do not
replace them with fixture shorthand or a different depth setting.
