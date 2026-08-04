# Canonical encoding and hashing

json-fn defines one canonical byte encoding for accepted JSON values and
versioned, domain-separated SHA-256 addresses over those bytes.

## Canonical JSON

Canonical encoding follows RFC 8785:

- Object keys are sorted by UTF-16 code units. This is not Unicode code-point
  order.
- Numbers use the ECMAScript number-to-string form for an IEEE-754 double.
  `1.0` encodes as `1`, `-0` as `0`, and exponent notation begins at `1e21`
  and below `1e-7`.
- Strings encode as UTF-8. JSON short escapes are used for `"`, `\`, backspace,
  tab, newline, form feed, and carriage return. Other control characters use
  lowercase `\u00xx`; all other characters are literal.
- Unicode normalization is not applied. NFC and NFD strings remain distinct.
- No insignificant whitespace is emitted.

Object key order is not part of structural equality, so structurally equal
objects produce the same canonical bytes.

### Accepted values

The encoding boundary rejects values instead of coercing or omitting them:

- cyclic values: `CYCLIC_VALUE`;
- unpaired UTF-16 surrogates in strings or keys: `MALFORMED_STRING`;
- non-finite numbers, undefined values, functions, symbols, big integers,
  non-plain host objects, symbol-keyed properties, sparse arrays, and arrays
  with named properties: `UNSUPPORTED_VALUE`.

The shared [structural-depth limit](execution-limits.md#structural-depth) also
applies.

Canonical encoding operates on values, not programs. Expression-shaped guest
data is encoded exactly as data. Program normalization is applied only by the
normalized module hash defined below.

## Hash framing

For a domain string `D` and payload bytes `P`, the digest input is:

```text
UTF8(D) || 0x0a || P
```

The address is:

```text
D:sha256:<lowercase hexadecimal digest>
```

For example:

```text
jfn:value:v1:sha256:9f2c...
```

The domain participates in both the digest and rendered address. Equal payload
bytes in different domains therefore have different addresses. A change to
the digest or encoding rules requires a new domain version.

## Domains

- `jfn:value:v1` identifies one complete accepted guest value. Its payload is
  canonical JSON.
- `jfn:blob:v1` identifies one physical blob payload. Its payload is the
  versioned blob bytes, including any codec or layout framing.
- `jfn:module:v1` identifies a module after program normalization, including
  `$types` and before contract-derived effect bindings are added.
- `jfn:module-artifact:v1` identifies the canonical module as parsed, before
  program normalization.
- `jfn:contract:v1` identifies the complete environment-contract document.
- `jfn:builtins:v1` identifies the record
  `{"engineVersion": string, "signatureTable": value}`. The engine version
  covers builtin behavior not represented by signatures.
- `jfn:profile:v1` identifies the deployment profile's semantic projection:
  mode, selected effects and durable classifications, and portable limits.
- `jfn:deployment:v1` identifies the executable deployment components.

A semantic value address is independent of physical storage. Chunk thresholds,
blob codecs, and layout do not participate in `jfn:value:v1`.

## Module identity

The two module domains have separate roles:

- `jfn:module-artifact:v1` records the parsed artifact before semantic
  normalization. It is provenance and diagnostic metadata.
- `jfn:module:v1` records the normalized program. Semantically neutral syntax
  differences normalize to one identity, so this is the module component used
  for enforcement.

Program normalization never applies to arbitrary guest values, contracts, or
profile projections.

## Deployment identity

The deployment address hashes the canonical JSON encoding of this component
record:

```json
{
  "module": "jfn:module:v1:sha256:...",
  "contract": "jfn:contract:v1:sha256:...",
  "builtins": "jfn:builtins:v1:sha256:...",
  "profile": "jfn:profile:v1:sha256:..."
}
```

The module-artifact address is carried separately as provenance and is not an
input to deployment identity. Component addresses allow a mismatch report to
identify the changed layer.

## Conformance vectors

`spec/hash-cases/*.json` pins canonical text and `jfn:value:v1` addresses for
key ordering, numbers, Unicode, special keys, and expression-shaped data.
Equivalent encoders must reproduce those vectors and the rejection
classifications above.
