# Canonical encoding and hashing

json-fn defines one canonical byte encoding for accepted guest values and a
family of domain-separated, versioned hashes built on it. This layer is the
shared foundation for durable module-identity pinning and (if measurements
justify it) content-addressed value storage. It is host-layer functionality:
nothing here changes evaluation, fuel, errors, or the conformance semantics of
the language.

The TypeScript implementation lives in `typescript/src/hashing/`.
Cross-runtime test vectors live in `spec/hash-cases/`.

## 1. Canonical JSON encoding

The canonical encoding of an accepted JSON value follows RFC 8785 (JSON
Canonicalization Scheme):

- **Object keys are sorted by UTF-16 code units** (the ECMAScript default
  string sort). Structural `eq` ignores object key order, so structurally
  equal values must — and do — produce identical canonical bytes. Note that
  UTF-16 code-unit order is not code-point order: a key spelled with a
  surrogate pair can sort before a key whose single code unit is larger than
  the high surrogate.
- **Numbers use the ECMAScript number-to-string algorithm** applied to the
  IEEE-754 double: `1.0` encodes as `1`, `-0` as `0`, and exponent notation
  begins at `1e21` and below `1e-7` (`1e+21`, `1e-7`). The authored spelling
  of a number is irrelevant; only the double it denotes matters.
- **Strings encode as UTF-8** with the short JSON escapes (`\"`, `\\`, `\b`,
  `\t`, `\n`, `\f`, `\r`) and lowercase `\u00xx` for other control
  characters; every other character is literal. No Unicode normalization is
  applied: NFC and NFD spellings are distinct values with distinct hashes.
- **No insignificant whitespace.**

### Boundary validation

The encoder owns the persistence/hash boundary: it deterministically rejects,
rather than silently coercing or dropping,

- cyclic values (`CYCLIC_VALUE`);
- strings containing unpaired surrogates, in values or keys
  (`MALFORMED_STRING`) — it never relies on a host UTF-8 encoder's
  replacement behavior; and
- non-finite numbers, `undefined`, functions, symbols, bigints, non-plain
  host objects (`Date`, `Map`, class instances), symbol-keyed properties, and
  arrays with holes or named properties (`UNSUPPORTED_VALUE`).

The walk enforces the portable structural-depth contract with the shared
counting rule and limit error (see `docs/execution-limits.md` section 4).

### Values, not programs

The canonical encoder operates on arbitrary JSON **values**. It never applies
program normalization: guest data may legitimately contain `$raw`-shaped,
`$var`-shaped, or otherwise expression-shaped objects, and value hashing
preserves the exact structural value it receives. Program normalization
participates in hashing only through the module-identity helpers below, where
the input is known to be program syntax.

## 2. Hash domains

Every hash occupies exactly one versioned domain. The domain string is part of
the digest input (equal bytes hash differently under different domains) and
part of the rendered address, so addresses are self-describing:

```
jfn:value:v1:sha256:9f2c...
```

SHA-256 is the v1 digest for every domain; it is available in the standard
library of every implementation, which the shared test vectors rely on.
Changing the digest or the encoding rules is a new domain version, never a
silent reinterpretation of existing addresses.

| Domain                   | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `jfn:value:v1`           | Semantic identity of one complete accepted guest value                  |
| `jfn:blob:v1`            | Address of one physical blob payload (at-rest codec; future work)       |
| `jfn:module:v1`          | Normalized semantic module identity (after program normalization)       |
| `jfn:module-artifact:v1` | Exact reviewed authored artifact (before program normalization)         |
| `jfn:contract:v1`        | Portable environment-contract document                                  |
| `jfn:builtins:v1`        | Full builtin signature table plus engine/stdlib semantic version        |
| `jfn:profile:v1`         | Deployment-profile semantic projection                                  |
| `jfn:deployment:v1`      | Aggregate executable-world identity over the component hashes           |

In the TypeScript implementation each domain is a distinct branded type
(`ValueHash`, `BlobHash`, `ModuleHash`, ...), so a hash cannot be substituted
across domains merely because the digest algorithms match.

Semantic value hashes are independent of physical storage by construction:
chunk thresholds, codec framing, and blob layout never participate in a
`ValueHash` input.

## 3. Module and deployment identity hashes

Two module hashes with two settled roles
(`plans/content-addressing/module-identity-pinning.md`):

- **`jfn:module-artifact:v1`** digests the canonical-JSON module exactly as
  reviewed — after shorthand parsing, before program normalization. It is
  provenance and diagnostic metadata ("is production running byte-for-byte
  what was approved?") and is never an enforcement input.
- **`jfn:module:v1`** digests the module after the context-sensitive program
  normalizer, so semantically neutral respellings (redundant-`$raw` removal,
  boundary hoisting) cannot create distinct identities. Identity enforcement
  keys on this hash only.

The aggregate `jfn:deployment:v1` hash covers the normalized module,
contract, builtin-table, and profile component hashes. The artifact hash is
deliberately excluded from the aggregate — otherwise a reformatting would
reject in-flight workflows — and is carried beside it in identity manifests.

Wiring these helpers into deployment preparation, workflow records, and
drift enforcement is owned by the module-identity-pinning plan.

## 4. Test vectors

`spec/hash-cases/*.json` contains cross-runtime-independent vectors: each case
records an input value, its canonical text, and its `jfn:value:v1` address,
covering key ordering, number spelling, Unicode, special keys (`__proto__`,
`$`- and `@`-prefixed names), and expression-shaped data. Every
implementation's encoder and value hash must reproduce them exactly.
Rejection behavior (unpaired surrogates, cycles, non-JSON host values) is not
JSON-representable and is pinned in implementation tests
(`typescript/test/hashing.test.ts`).

The TypeScript vectors are generated by
`bun run generate:hash-cases` (from `typescript/`); regenerate after any
deliberate, domain-versioned encoding change.
