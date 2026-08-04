import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  blobHash,
  builtinTableHash,
  CanonicalEncodingError,
  canonicalJsonBytes,
  canonicalJsonText,
  contractHash,
  deploymentHash,
  hashWithDomain,
  moduleArtifactHash,
  moduleHash,
  profileProjectionHash,
  valueHash,
  type JSONType,
} from "../src";
import { setOwnProperty } from "../src/own-properties";
import { MAX_STRUCTURAL_DEPTH } from "../src/structural-depth";

type VectorCase = { name: string; value: unknown; canonical: string; valueHash: string };
type VectorFile = { description: string; cases: VectorCase[] };

// Phase 3 gate: cross-runtime-independent vectors for key ordering, number
// spelling, Unicode, special keys, and expression-shaped data.
const casesDirectory = join(import.meta.dir, "../../spec/cases/hash");
for (const path of new Bun.Glob("*.json").scanSync(casesDirectory)) {
  const suite = (await Bun.file(join(casesDirectory, path)).json()) as VectorFile;
  describe(`cases/hash/${path}: ${suite.description}`, () => {
    for (const item of suite.cases) {
      test(item.name, () => {
        expect(canonicalJsonText(item.value)).toBe(item.canonical);
        expect(valueHash(item.value)).toBe(item.valueHash as ReturnType<typeof valueHash>);
      });
    }
  });
}

describe("structural equality implies equal semantic hashes", () => {
  test("key insertion order is invisible", () => {
    const sorted = { a: 1, b: [true, { x: null, y: "s" }], c: 3 };
    const shuffled = { c: 3, b: [true, { y: "s", x: null }], a: 1 };
    expect(valueHash(shuffled)).toBe(valueHash(sorted));
  });

  test("construction route is invisible", () => {
    const literal = { ["__proto__"]: { marker: 1 }, plain: 2 };
    const constructed: Record<string, JSONType> = {};
    setOwnProperty(constructed, "plain", 2);
    setOwnProperty(constructed, "__proto__", { marker: 1 });
    const parsed = JSON.parse('{"plain":2,"__proto__":{"marker":1}}') as JSONType;
    expect(valueHash(constructed)).toBe(valueHash(literal));
    expect(valueHash(parsed)).toBe(valueHash(literal));
  });

  test("equal deep trees hash equal; a one-leaf difference does not", () => {
    const make = (leaf: number): JSONType => {
      let node: JSONType = leaf;
      for (let level = 0; level < 100; level++) node = { level, child: [node] };
      return node;
    };
    expect(valueHash(make(1))).toBe(valueHash(make(1)));
    expect(valueHash(make(2))).not.toBe(valueHash(make(1)));
  });

  test("scalar spelling collapses to the double: 1.0, 1, and -0, 0", () => {
    expect(valueHash(1.0)).toBe(valueHash(1));
    expect(valueHash(-0)).toBe(valueHash(0));
  });
});

describe("hash domains are separated and versioned", () => {
  test("equal bytes under different domains give different digests", () => {
    const value = { shared: true };
    const digestOf = (address: string): string => address.split(":").at(-1)!;
    const addresses = [
      valueHash(value),
      blobHash(canonicalJsonBytes(value)),
      moduleArtifactHash(value),
      moduleHash(value),
      contractHash(value),
      profileProjectionHash(value),
    ];
    expect(new Set(addresses.map(digestOf)).size).toBe(addresses.length);
  });

  test("addresses are self-describing: domain, version, algorithm, digest", () => {
    expect(valueHash(null)).toMatch(/^jfn:value:v1:sha256:[0-9a-f]{64}$/);
    expect(blobHash(new Uint8Array([1, 2, 3]))).toMatch(/^jfn:blob:v1:sha256:[0-9a-f]{64}$/);
    expect(hashWithDomain("jfn:test:v1", new Uint8Array())).toMatch(
      /^jfn:test:v1:sha256:[0-9a-f]{64}$/,
    );
  });

  test("blob hashing is byte-level, not value-level: different payload bytes for one value differ", () => {
    // Physical layout (whitespace, chunking, codec framing) may vary; the
    // semantic ValueHash cannot.
    const compact = new TextEncoder().encode('{"a":1}');
    const padded = new TextEncoder().encode('{ "a": 1 }');
    expect(blobHash(padded)).not.toBe(blobHash(compact));
    expect(valueHash(JSON.parse('{"a":1}'))).toBe(valueHash(JSON.parse('{ "a": 1 }')));
  });

  test("aggregate deployment hash is order-insensitive over its components", () => {
    const module = { entry: { $return: 1, $params: [] } } as JSONType;
    const components = {
      module: moduleHash(module),
      contract: contractHash({ callables: {} }),
      builtins: builtinTableHash({ add: { args: 2 } }, "1.0.0"),
      profile: profileProjectionHash({ mode: "live" }),
    };
    expect(deploymentHash(components)).toBe(
      deploymentHash({
        profile: components.profile,
        builtins: components.builtins,
        contract: components.contract,
        module: components.module,
      }),
    );
    expect(
      deploymentHash({ ...components, builtins: builtinTableHash({ add: { args: 2 } }, "1.0.1") }),
    ).not.toBe(deploymentHash(components));
  });
});

describe("program normalization integrates only for program identity", () => {
  // A `$raw` wrapper around `$`-free static data is semantically redundant in
  // program syntax: the normalizer removes it (raw-semantics-cleanup.md).
  const authored = { answer: { $raw: { config: [1, 2, 3] } } } as JSONType;
  const respelled = { answer: { config: [1, 2, 3] } } as JSONType;

  test("normalized module identity ignores redundant raw respelling", () => {
    expect(moduleHash(authored)).toBe(moduleHash(respelled));
  });

  test("artifact identity preserves the exact reviewed spelling", () => {
    expect(moduleArtifactHash(authored)).not.toBe(moduleArtifactHash(respelled));
  });

  test("value hashing never rewrites expression-shaped guest data", () => {
    expect(valueHash(authored)).not.toBe(valueHash(respelled));
    expect(canonicalJsonText(authored)).toBe('{"answer":{"$raw":{"config":[1,2,3]}}}');
  });
});

describe("boundary validation rejects unsupported values deterministically", () => {
  const expectRejection = (value: unknown, code: string, path?: string): void => {
    let caught: unknown;
    try {
      canonicalJsonText(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalEncodingError);
    expect(caught).toMatchObject(path === undefined ? { code } : { code, path });
  };

  test("non-finite numbers", () => {
    expectRejection(Number.NaN, "UNSUPPORTED_VALUE", "$");
    expectRejection(Number.POSITIVE_INFINITY, "UNSUPPORTED_VALUE", "$");
    expectRejection({ a: [Number.NEGATIVE_INFINITY] }, "UNSUPPORTED_VALUE", "$.a[0]");
  });

  test("non-JSON host values", () => {
    expectRejection(undefined, "UNSUPPORTED_VALUE");
    expectRejection({ a: undefined }, "UNSUPPORTED_VALUE", "$.a");
    expectRejection(() => 1, "UNSUPPORTED_VALUE");
    expectRejection(Symbol("s"), "UNSUPPORTED_VALUE");
    expectRejection(10n, "UNSUPPORTED_VALUE");
    expectRejection({ when: new Date(0) }, "UNSUPPORTED_VALUE", "$.when");
    expectRejection(new Map(), "UNSUPPORTED_VALUE");
  });

  test("arrays with holes or named properties", () => {
    // eslint-disable-next-line no-sparse-arrays
    expectRejection([1, , 3], "UNSUPPORTED_VALUE", "$");
    const named: number[] = [1, 2];
    setOwnProperty(named as unknown as Record<string, number>, "extra", 3);
    expectRejection(named, "UNSUPPORTED_VALUE", "$");
  });

  test("symbol-keyed properties", () => {
    const marked = { plain: 1 };
    (marked as Record<symbol, unknown>)[Symbol("mark")] = true;
    expectRejection(marked, "UNSUPPORTED_VALUE", "$");
  });

  test("strings with unpaired surrogates, in values and keys", () => {
    expectRejection("\uD800", "MALFORMED_STRING", "$");
    expectRejection("\uDC00", "MALFORMED_STRING", "$");
    expectRejection({ a: "ok\uD800" }, "MALFORMED_STRING", "$.a");
    expectRejection({ ["bad\uDC00"]: 1 }, "MALFORMED_STRING");
  });

  test("cyclic values fail with a cycle error, not a stack failure", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = { back: cyclic };
    expectRejection(cyclic, "CYCLIC_VALUE", "$.self.back");
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expectRejection(cyclicArray, "CYCLIC_VALUE", "$[0]");
  });

  test("well-formed surrogate pairs are accepted", () => {
    expect(canonicalJsonText("\u{1F600}")).toBe('"\u{1F600}"');
  });
});

describe("structural depth follows the shared portable contract", () => {
  const nest = (depth: number): JSONType => {
    let node: JSONType = "leaf";
    for (let level = 0; level < depth; level++) node = [node];
    return node;
  };

  test("depth at the limit encodes", () => {
    const text = canonicalJsonText(nest(MAX_STRUCTURAL_DEPTH));
    expect(text.startsWith("[[[")).toBe(true);
  });

  test("depth beyond the limit fails with the canonical limit error", () => {
    expect(() => canonicalJsonText(nest(MAX_STRUCTURAL_DEPTH + 1))).toThrow(
      `Maximum structural depth of ${MAX_STRUCTURAL_DEPTH} exceeded`,
    );
  });
});
