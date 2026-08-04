/**
 * One-shot generator for `spec/hash-cases/` (roadmap Phase 3). Values are
 * authored here; `canonical` and `valueHash` are computed by the TypeScript
 * implementation and reviewed against RFC 8785 before the vectors are
 * committed. Other implementations consume the committed JSON files.
 */
import { join } from "path";
import { canonicalJsonText, valueHash } from "../src/hashing";

type VectorCase = { name: string; value: unknown };

// `JSON.stringify(-0)` emits `0`, which would silently turn negative-zero
// vectors into positive zero in the committed file. Emit a placeholder and
// substitute the literal `-0` JSON token afterwards.
const NEG_ZERO = "__NEG_ZERO__";

function withNegZeroPlaceholders(value: unknown): unknown {
  if (typeof value === "number") return Object.is(value, -0) ? NEG_ZERO : value;
  if (Array.isArray(value)) return value.map(withNegZeroPlaceholders);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withNegZeroPlaceholders(entry)]),
    );
  }
  return value;
}

function buildFile(description: string, cases: VectorCase[]): string {
  const entries = cases.map(({ name, value }) => ({
    name,
    value: withNegZeroPlaceholders(value),
    canonical: canonicalJsonText(value),
    valueHash: valueHash(value),
  }));
  const text = JSON.stringify({ description, cases: entries }, null, 2);
  return `${text.replaceAll(`"${NEG_ZERO}"`, "-0")}\n`;
}

const files: Record<string, { description: string; cases: VectorCase[] }> = {
  "key-ordering.json": {
    description:
      "Canonical encoding sorts object keys by UTF-16 code units; structurally equal objects that differ only in authored key order share one canonical form and one value hash",
    cases: [
      { name: "already sorted", value: { a: 1, b: 2, c: 3 } },
      { name: "reverse authored order", value: { c: 3, b: 2, a: 1 } },
      { name: "interleaved authored order", value: { b: 2, a: 1, c: 3 } },
      {
        name: "nested objects sort at every level",
        value: { outer: { z: 1, a: { m: 2, b: 3 } }, first: true },
      },
      { name: "empty-string key sorts first", value: { "": 0, a: 1 } },
      {
        name: "digits sort before uppercase before lowercase",
        value: { b: 2, A: 1, "1": 0 },
      },
      {
        name: "utf-16 code-unit order, not code-point order: surrogate pair sorts before U+FFFD",
        value: { "\uFFFD": "replacement", "\u{1D7D8}": "mathematical double-struck zero" },
      },
      {
        name: "accented key sorts after ascii by code unit",
        value: { "\u00E9": "e-acute", z: "z" },
      },
    ],
  },
  "number-spelling.json": {
    description:
      "Canonical number spelling is the ECMAScript number-to-string algorithm applied to the IEEE-754 double: 1.0 encodes as 1, -0 as 0, with JS exponent thresholds at 1e21 and 1e-7",
    cases: [
      { name: "zero", value: 0 },
      { name: "negative zero encodes as 0", value: -0 },
      { name: "one authored as 1.0 encodes as 1", value: 1.0 },
      { name: "small negative integer", value: -42 },
      { name: "plain fraction", value: 0.1 },
      { name: "fraction below one with leading zero", value: 0.5 },
      { name: "largest exact integer boundary", value: 9007199254740992 },
      { name: "max safe integer", value: 9007199254740991 },
      { name: "just below the positive exponent threshold", value: 1e20 },
      { name: "positive exponent threshold uses e+ notation", value: 1e21 },
      { name: "large double beyond the threshold", value: 1e23 },
      { name: "just above the negative exponent threshold", value: 0.000001 },
      { name: "negative exponent threshold uses e notation", value: 1e-7 },
      // RFC 8785 appendix authors this as 333333333.33333329; the shortest
      // spelling of the same double avoids the lint precision warning.
      { name: "precision-limited fraction rounds to shortest form", value: 333333333.3333333 },
      { name: "smallest positive double", value: 5e-324 },
      { name: "largest positive double", value: 1.7976931348623157e308 },
      { name: "numbers inside containers", value: [1.0, -0, 1e21, 1e-7] },
    ],
  },
  "unicode.json": {
    description:
      "Canonical string bytes are UTF-8 with the short JSON escapes and lowercase \\u00xx for other control characters; no Unicode normalization is applied, so NFC and NFD spellings are distinct values with distinct hashes",
    cases: [
      { name: "ascii", value: "hello" },
      { name: "two-byte utf-8", value: "caf\u00E9" },
      { name: "three-byte utf-8", value: "\u65E5\u672C\u8A9E" },
      { name: "astral plane emoji", value: "\u{1F600}" },
      { name: "nfc e-acute", value: "\u00E9" },
      { name: "nfd e plus combining acute", value: "e\u0301" },
      { name: "quote and backslash use short escapes", value: 'quote " backslash \\' },
      { name: "named control escapes", value: "\b\t\n\f\r" },
      { name: "other control characters use lowercase u00xx", value: "\u0000\u0007\u001F" },
      { name: "delete control character is literal", value: "\u007F" },
      { name: "escaped and literal spellings are one value", value: "\u00E9\u65E5" },
      { name: "unicode inside keys and arrays", value: { "\u{1F600}": ["\u00E9", "e\u0301"] } },
    ],
  },
  "special-keys.json": {
    description:
      "Keys with host-prototype or tag-like names are ordinary data at the value layer: __proto__, constructor, empty, $-prefixed, and @-prefixed keys all survive canonical encoding as own properties",
    cases: [
      { name: "proto key", value: { ["__proto__"]: { polluted: true }, safe: 1 } },
      { name: "constructor and prototype keys", value: { constructor: 1, prototype: 2 } },
      { name: "toString key", value: { toString: "data" } },
      { name: "empty-string key", value: { "": "empty" } },
      { name: "dollar-prefixed keys as plain data", value: { $call: "add", $args: [1, 2] } },
      { name: "at-prefixed codec-tag-like keys as plain data", value: { "@blob": "not a ref" } },
      { name: "lit-tag-like key as plain data", value: { "@lit": { "@blob": "still data" } } },
      {
        name: "special keys sort with ordinary keys",
        value: { zebra: 1, ["__proto__"]: 2, "": 3, $var: 4 },
      },
    ],
  },
  "expression-shaped.json": {
    description:
      "Value hashing never applies program normalization: expression-shaped guest data — including semantically redundant $raw wrappers a program normalizer would rewrite — hashes as the exact structure it is",
    cases: [
      { name: "raw-wrapped scalar is a distinct structure", value: { $raw: 42 } },
      { name: "the bare scalar", value: 42 },
      {
        name: "redundant raw wrapper around static data is preserved",
        value: { $raw: { config: [1, 2, 3] } },
      },
      { name: "the unwrapped static data", value: { config: [1, 2, 3] } },
      { name: "var-shaped object", value: { $var: "x" } },
      {
        name: "call-shaped object",
        value: { $call: "add", $args: [{ $var: "x" }, 1] },
      },
      {
        name: "raw payload containing expression-shaped data",
        value: { $raw: { $call: "add", $args: [1, 2] } },
      },
      {
        name: "function-body-shaped object",
        value: { $return: { $var: "n" }, $params: ["n"] },
      },
    ],
  },
};

const outDir = join(import.meta.dir, "../../spec/hash-cases");
for (const [name, { description, cases }] of Object.entries(files)) {
  await Bun.write(join(outDir, name), buildFile(description, cases));
  console.log(`wrote spec/hash-cases/${name} (${cases.length} cases)`);
}
