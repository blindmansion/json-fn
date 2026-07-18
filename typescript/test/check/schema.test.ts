import { describe, expect, test } from "bun:test";
import {
  classifySchema,
  mergeSchemas,
  SchemaKind,
  type Defs,
  type Schema,
  unionOf,
} from "../../src/schema/schema.ts";
import { isSubschema } from "../../src/check/subsumption";

// ---------------------------------------------------------------------------
// Section B — classification
// ---------------------------------------------------------------------------

describe("classifySchema", () => {
  const cases: [string, Schema, SchemaKind][] = [
    ["any", true, SchemaKind.Any],
    ["never", false, SchemaKind.Never],
    ["primitive string", { type: "string" }, SchemaKind.Primitive],
    ["primitive integer", { type: "integer" }, SchemaKind.Primitive],
    ["const", { const: 42 }, SchemaKind.Const],
    ["enum", { enum: ["a", "b"] }, SchemaKind.Enum],
    ["type-array union", { type: ["number", "null"] }, SchemaKind.Union],
    ["anyOf union", { anyOf: [{ type: "string" }, { type: "number" }] }, SchemaKind.Union],
    ["array", { type: "array", items: { type: "string" } }, SchemaKind.Array],
    ["array (open items)", { type: "array" }, SchemaKind.Array],
    [
      "tuple",
      { type: "array", prefixItems: [{ type: "number" }], items: false, minItems: 1 },
      SchemaKind.Tuple,
    ],
    ["object", { type: "object", properties: {}, required: [] }, SchemaKind.Object],
    ["ref", { $ref: "#/$defs/User" }, SchemaKind.Ref],
    [
      "fnType",
      { $fnType: { required: [], optional: [], returns: { type: "boolean" } } },
      SchemaKind.FnType,
    ],
    ["opaque (not)", { not: { type: "string" } }, SchemaKind.Opaque],
    ["opaque (bare)", {}, SchemaKind.Opaque],
  ];

  for (const [name, schema, kind] of cases) {
    test(name, () => expect(classifySchema(schema)).toBe(kind));
  }
});

describe("unionOf", () => {
  test("recursively flattens nested anyOf and removes never arms", () => {
    expect(
      unionOf([
        { type: "string" },
        { anyOf: [false, { type: "number" }, { anyOf: [{ type: "string" }] }] },
      ]),
    ).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  test("a nested any arm absorbs the union", () => {
    expect(unionOf([{ type: "string" }, { anyOf: [{ type: "number" }, true] }])).toBe(true);
  });

  test("removes scalar literals covered by primitive arms regardless of order", () => {
    expect(unionOf([{ const: 0 }, { type: "integer" }])).toEqual({ type: "integer" });
    expect(unionOf([{ type: "number" }, { const: 1 }])).toEqual({ type: "number" });
    expect(unionOf([{ const: "x" }, { type: "string" }])).toEqual({ type: "string" });
    expect(unionOf([{ type: "boolean" }, { const: true }])).toEqual({ type: "boolean" });
    expect(unionOf([{ const: null }, { type: "null" }])).toEqual({ type: "null" });
  });

  test("removes finite literal arms covered by enums and type-array unions", () => {
    expect(unionOf([{ const: "a" }, { enum: ["a", "b"] }])).toEqual({ enum: ["a", "b"] });
    expect(unionOf([{ enum: [1, 2] }, { type: ["integer", "string"] }])).toEqual({
      type: ["integer", "string"],
    });
  });

  test("keeps literals not definitely covered by another arm", () => {
    expect(unionOf([{ const: 0 }, { type: "string" }])).toEqual({
      anyOf: [{ const: 0 }, { type: "string" }],
    });
    expect(unionOf([{ const: 0 }, { type: "integer", minimum: 1 }])).toEqual({
      anyOf: [{ const: 0 }, { type: "integer", minimum: 1 }],
    });
    expect(unionOf([{ enum: ["a", 1] }, { type: "string" }])).toEqual({
      anyOf: [{ enum: ["a", 1] }, { type: "string" }],
    });
  });
});

// ---------------------------------------------------------------------------
// mergeSchemas — the type-level model of `merge`'s shallow spread { ...a, ...b }
// ---------------------------------------------------------------------------

describe("mergeSchemas", () => {
  const I: Schema = { type: "integer" };
  const S: Schema = { type: "string" };
  const B: Schema = { type: "boolean" };
  const closed = (props: Record<string, Schema>, required: string[]): Schema => ({
    type: "object",
    properties: props,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  });

  test("RHS wins on a shared key; disjoint keys are unioned in", () => {
    const a = closed({ id: S, n: I }, ["id", "n"]);
    const b = closed({ n: S, extra: B }, ["n", "extra"]);
    expect(mergeSchemas(a, b, {})).toEqual(closed({ id: S, n: S, extra: B }, ["id", "n", "extra"]));
  });

  test("a closed all-required RHS preserves the LHS shape (the update idiom)", () => {
    const a = closed({ id: S, n: I }, ["id", "n"]);
    const b = closed({ n: I }, ["n"]);
    // { id, n } after overriding n with an integer is still assignable to a.
    expect(isSubschema(mergeSchemas(a, b, {}), a)).toBe(true);
  });

  test("a map LHS keeps its additionalProperties value type", () => {
    const map: Schema = { type: "object", additionalProperties: I };
    const merged = mergeSchemas(map, closed({ a: I }, ["a"]), {}) as Record<string, Schema>;
    expect(merged.additionalProperties).toEqual(I);
    // A wrong-typed extra key is not assignable back to the map.
    expect(isSubschema(mergeSchemas(map, closed({ a: S }, ["a"]), {}), map)).toBe(false);
  });

  test("an open RHS makes the result open (b can bring arbitrary keys)", () => {
    const a = closed({ id: S }, ["id"]);
    const open: Schema = { type: "object", properties: {} };
    const merged = mergeSchemas(a, open, {}) as Record<string, Schema>;
    expect("additionalProperties" in merged).toBe(false); // open-by-default
  });

  test("a union LHS distributes the merge over its arms", () => {
    const a: Schema = {
      anyOf: [
        closed({ tag: { const: "x" }, n: I }, ["tag", "n"]),
        closed({ tag: { const: "y" } }, ["tag"]),
      ],
    };
    const merged = mergeSchemas(a, closed({ k: B }, ["k"]), {});
    expect(classifySchema(merged)).toBe(SchemaKind.Union);
  });

  test("a $ref operand resolves; a non-object or any operand degrades", () => {
    const defs: Defs = { A: closed({ id: S }, ["id"]) };
    const viaRef = mergeSchemas({ $ref: "#/$defs/A" }, closed({ n: I }, ["n"]), defs);
    expect(isSubschema(viaRef, closed({ id: S, n: I }, ["id", "n"]))).toBe(true);
    expect(mergeSchemas(true, closed({ n: I }, ["n"]), {})).toBe(true); // any absorbs
    expect(mergeSchemas(I, closed({ n: I }, ["n"]), {})).toEqual({ type: "object" }); // floor
  });
});
