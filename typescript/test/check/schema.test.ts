import { describe, expect, test } from "bun:test";
import { classifySchema, SchemaKind, type Schema } from "../../src/check/schema";

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
    ["fnType", { $fnType: { params: [], returns: { type: "boolean" } } }, SchemaKind.FnType],
    ["opaque (not)", { not: { type: "string" } }, SchemaKind.Opaque],
    ["opaque (bare)", {}, SchemaKind.Opaque],
  ];

  for (const [name, schema, kind] of cases) {
    test(name, () => expect(classifySchema(schema)).toBe(kind));
  }
});
