# Environment contract

An environment contract is the portable, operator-owned boundary between a
json-fn module and its host. It declares the named schemas, direct host
functions, effects, and production entry that the module may use. It contains no
executable host code and is independent of a particular deployment.

The TypeScript API calls this value `EnvironmentContract`; files conventionally use the
`.contract.json` suffix.

## Version 1 JSON shape

```json
{
  "version": 1,
  "$defs": {
    "UserId": { "type": "string", "pattern": "^u_" }
  },
  "functions": {
    "lookupUser": {
      "signatures": [
        {
          "required": [{ "$ref": "#/$defs/UserId" }],
          "optional": [],
          "returns": {
            "type": "object",
            "properties": { "name": { "type": "string" } },
            "required": ["name"],
            "additionalProperties": false
          }
        }
      ]
    }
  },
  "effects": {
    "log.write": {
      "params": [{ "type": "string" }],
      "returns": { "type": "null" }
    }
  },
  "entry": {
    "name": "main",
    "required": [{ "$ref": "#/$defs/UserId" }],
    "optional": [],
    "returns": { "task": { "type": "string" } }
  }
}
```

The top-level object is closed: only `version`, `$defs`, `functions`, `effects`,
and `entry` are supported. `version` and `entry` are required. `$defs`,
`functions`, and `effects` may be omitted and then behave as empty objects.
Version 1 is the only supported version.

### Ownership

- **`$defs`** contains boundary schemas owned by the operator. EnvironmentContract
  function, effect, and entry schemas may refer to them with
  `{"$ref":"#/$defs/Name"}`.
- **`functions`** declares direct host callables. Each callable uses the same
  signature shape as the builtin table: one or more `signatures`, each with
  `required`, `optional`, optional `rest`, and `returns`; polymorphic signatures
  may also declare `typeParams`. Optional descriptive metadata is supported by
  callable entries.
- **`effects`** declares task effects. Each effect has exactly `params` and
  `returns`. Effects do not have optional or rest parameters.
- **`entry`** selects one module function as the production boundary.
  `required` and `optional` are both mandatory arrays. `returns: A` declares a
  direct result; `returns: {"task": A}` declares a task whose eventual
  completion value is `A`.

The contract owns the entry boundary even when the module also carries an
inline `$sig`. Linking and checking require the module entry to satisfy the
contract; the module cannot replace the operator's argument or result contract.

## Direct functions and task effects

A contract function is called synchronously from guest evaluation. The runtime adapter
implementation is installed in the function registry, and tractable
arguments/results are checked at that call boundary. It cannot suspend and
should be used only for direct computations the host is willing to expose as a
function.

An effect call such as `effects.log.write(message)` is different: it purely
constructs `Task<Result>`. The host capability runs only when `runTask` or the
durable driver reaches that pending effect. The contract describes the effect;
a [deployment profile](deployment-profile.md) decides whether and how that
effect crosses a particular host boundary.

Qualification is intentional: a direct function named `log` and an effect
named `log` have distinct guest syntax and execution semantics.

## Reserved and collision rules

- `Task` is the built-in task type constructor. Neither contract `$defs` nor
  module `$types` may define it.
- `effects` is reserved in contract-linked modules. The linker injects this
  top-level binding from the effect manifest, so the module and the contract
  entry may not use that name as their top-level entry binding.
- `raise` is intrinsic. It is not selected in deployment profiles and is
  handled separately from declared host effects.
- An effect name must be non-empty. Dot-separated names form the injected
  namespace, so one effect name cannot be a prefix of another (`sensor` and
  `sensor.read` conflict).
- EnvironmentContract function names may not duplicate core builtin callable names.
- Named schemas never shadow across ownership layers. A name duplicated between
  builtin `$defs`, contract `$defs`, or module `$types` is a link error rather
  than an override. All three sources feed one definition pool used by the
  checker and runtime.

Module value/function bindings still follow normal lexical shadowing rules.
That is separate from the no-shadowing rule for schema definition names.

## Structural and behavioral parity

The JSON artifact is portable only if runtimes agree on its **structural
parity**: accepted fields and versions, schema-fragment validation, reserved
names, collision rules, reference resolution, and stable error code/path
classification. The vectors in `spec/validation-cases/` target that layer.

**Behavioral parity** is broader: a `RuntimeAdapter` host must enforce entry,
direct-function, effect-argument, effect-result, and completion contracts at the
same moments and must agree on task dispatch and failures. Those behaviors
require executable runtime adapters and are not established merely because the JSON
artifact validates. Cross-runtime behavioral runtime-adapter vectors are future
conformance work.

## Validation and linking APIs

The TypeScript package exports:

```ts
validateEnvironmentContract(value);
const contract = loadEnvironmentContract(path);
const linked = linkModule({ module, contract });
```

`validateEnvironmentContract` checks one contract and throws `EnvironmentContractValidationError`
(`code: "INVALID_CONTRACT"`, with a `path`) on structural failure, or
`DuplicateCallableContractError` (`code: "DUPLICATE_CALLABLE"`) for a contract
function that collides with an engine builtin.
`loadEnvironmentContract` parses JSON and performs the same validation. All three APIs use
the engine builtin callable and definition table by default, so builtin
references and collisions are checked even for standalone callers. `linkModule`
adds module-level collision, entry, and reserved-binding checks and builds the
injected `effects` namespace.

CLI validation uses the canonical builtin definitions automatically:

```sh
cd typescript
bun run src/cli.ts validate-contract --file ../examples/dungeon.contract.json
bun run src/cli.ts check --contract ../examples/dungeon.contract.json \
  --file ../examples/dungeon.jfn
```

`validate-contract` validates the artifact alone. `check --contract` also links
it to the module and checks the contract-owned entry boundary. For deployment
selection and runtime-adapter binding, continue with
[Deployment profiles](deployment-profile.md).
