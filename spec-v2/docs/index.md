# json-fn documentation

These documents define the language, authoring syntax, and portable hosting
boundary.

## Choose a path

### Write a `.jfn` module

Start with [Writing json-fn](guides/writing-jfn.md), then use the
[builtins catalog](builtins/builtins.md) as a lookup reference. For exact
syntax and type rules, consult the
[shorthand language reference](language/shorthand/index.md) and
[type syntax reference](language/shorthand/type-syntax-spec.md).

### Understand the language

Start with the [JSON language reference index](language/json/index.md) for
canonical semantics, including expressions, functions, narrowing, effects, and
runtime constraints. Use the
[shorthand language reference](language/shorthand/index.md) for `.jfn`
authoring syntax, type syntax, lowering rules, and grammar. For the builtin
registry dialect and polymorphism rules, see
[builtin type signatures](builtins/builtin-signatures.md).

### Deploy or host a module

The portable operator-owned artifacts are the
[environment contract](deployment/environment-contract.md) and
[deployment profile](deployment/deployment-profile.md). Runtime behavior is
covered by [execution limits](runtime/execution-limits.md),
[canonical encoding and hashing](runtime/hashing.md), and the
[durable host guide](runtime/durable-host.md).

### Implement json-fn

Use the [parse conformance guide](conformance/parsing.md) and
[builtin conformance guide](conformance/builtins.md) to run the shared cases
against an implementation.

## Catalog

### Guides

- [Writing json-fn](guides/writing-jfn.md) — concise agent-facing guide to
  authoring `.jfn` modules.

### Language

- [JSON language reference](language/json/index.md) — canonical JSON forms and
  evaluation semantics.
- [Shorthand language reference](language/shorthand/index.md) — `.jfn` surface
  syntax and lowering rules.
- [Type syntax reference](language/shorthand/type-syntax-spec.md) — type notation
  and schema lowering.
- [Flow narrowing](language/json/narrowing.md) — branch-sensitive static
  narrowing rules.

### Builtins

- [Builtins](builtins/builtins.md) — signature and description catalog.
- [Builtin type signatures](builtins/builtin-signatures.md) — shared registry
  dialect, polymorphism, and semantic rules.

### Conformance

- [Parse conformance](conformance/parsing.md) — requirements for shorthand
  parser adapters, result comparison, and portable diagnostics.
- [Builtin conformance](conformance/builtins.md) — requirements for direct
  builtin test adapters and result checking.

### Runtime

- [Execution limits](runtime/execution-limits.md) — fuel, call depth, value
  size, cancellation, and fixed structural limits.
- [Canonical encoding and hashing](runtime/hashing.md) — canonical guest-value
  bytes and domain-separated identity hashes.
- [Durable task hosting](runtime/durable-host.md) — persistence,
  delivery, recovery, and failure semantics.

### Deployment

- [Environment contract](deployment/environment-contract.md) — portable
  capability boundary and entry declaration.
- [Deployment profile](deployment/deployment-profile.md) — portable live or
  durable deployment selection.
