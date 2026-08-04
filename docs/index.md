# json-fn documentation

The TypeScript implementation is canonical. These documents define the shared
language, authoring syntax, and portable hosting boundary.

## Choose a path

### Write a `.jfn` module

Start with [Writing json-fn](guides/writing-jfn.md), then use the generated
[builtins catalog](builtins/builtins.md) as a lookup reference. For exact
syntax and type rules, consult the
[shorthand specification](language/shorthand-spec.md) and
[type syntax specification](language/type-syntax-spec.md).

### Understand or implement the language

The [JSON language reference](language/json/index.md) is the canonical semantics
reference. The remaining references cover
[shorthand syntax](language/shorthand-spec.md),
[type syntax](language/type-syntax-spec.md),
[flow narrowing](language/json/narrowing.md), and
[builtin type signatures](builtins/builtin-signatures.md).

### Deploy or host a module

The portable operator-owned artifacts are the
[environment contract](deployment/environment-contract.md) and
[deployment profile](deployment/deployment-profile.md). Runtime behavior is
covered by [execution limits](runtime/execution-limits.md),
[canonical encoding and hashing](runtime/hashing.md), and the
[durable host guide](runtime/durable-host.md).

## Catalog

### Guides

- [Writing json-fn](guides/writing-jfn.md) — concise agent-facing guide to
  authoring `.jfn` modules.

### Language

- [JSON language reference](language/json/index.md) — canonical JSON forms and
  evaluation semantics.
- [Shorthand specification](language/shorthand-spec.md) — `.jfn` surface
  syntax and lowering rules.
- [Type syntax specification](language/type-syntax-spec.md) — type notation
  and schema lowering.
- [Flow narrowing](language/json/narrowing.md) — frozen checker narrowing rules.

### Builtins

- [Builtins](builtins/builtins.md) — generated signature and description
  catalog sourced from `spec/builtins.json`.
- [Builtin type signatures](builtins/builtin-signatures.md) — shared registry
  dialect, polymorphism, and semantic rules.

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
