import { describe, expect, test } from "bun:test";
import { type Defs, type Schema } from "../../src/check/schema";
import { valueSatisfies } from "../../src/check/values";

// ---------------------------------------------------------------------------
// valueSatisfies (runtime-validation seed)
// ---------------------------------------------------------------------------

describe("valueSatisfies", () => {
  test("primitives & refinements", () => {
    expect(valueSatisfies(5, { type: "integer", minimum: 0 })).toBe(true);
    expect(valueSatisfies(-1, { type: "integer", minimum: 0 })).toBe(false);
    expect(valueSatisfies(4.5, { type: "integer" })).toBe(false);
    expect(valueSatisfies("u_123", { type: "string", pattern: "^u_" })).toBe(true);
  });
  test("enums, unions, null", () => {
    expect(valueSatisfies("b", { enum: ["a", "b"] })).toBe(true);
    expect(valueSatisfies(null, { type: ["number", "null"] })).toBe(true);
    expect(valueSatisfies(true, { type: ["number", "null"] })).toBe(false);
  });
  test("objects (closed) and arrays", () => {
    const cell: Schema = {
      type: "object",
      properties: { from: { type: "integer" }, to: { type: "integer" } },
      required: ["from", "to"],
      additionalProperties: false,
    };
    expect(valueSatisfies({ from: 1, to: 2 }, cell)).toBe(true);
    expect(valueSatisfies({ from: 1, to: 2, extra: 3 }, cell)).toBe(false);
    expect(valueSatisfies({ from: 1 }, cell)).toBe(false);
    expect(valueSatisfies([1, 2, 3], { type: "array", items: { type: "integer" } })).toBe(true);
    expect(valueSatisfies([1, "x"], { type: "array", items: { type: "integer" } })).toBe(false);
  });
  test("tuple minItems permits trailing prefix items to be omitted", () => {
    const tuple: Schema = {
      type: "array",
      prefixItems: [{ type: "integer" }, { type: "string" }],
      items: false,
      minItems: 1,
    };

    expect(valueSatisfies([1], tuple)).toBe(true);
    expect(valueSatisfies([1, "optional"], tuple)).toBe(true);
    expect(valueSatisfies([], tuple)).toBe(false);
    expect(valueSatisfies([1, "optional", 3], tuple)).toBe(false);
  });
  test("recursive value via $defs", () => {
    const defs: Defs = {
      Tree: {
        type: "object",
        properties: {
          value: { type: "number" },
          children: { type: "array", items: { $ref: "#/$defs/Tree" } },
        },
        required: ["value", "children"],
        additionalProperties: false,
      },
    };
    const tree = { value: 1, children: [{ value: 2, children: [] }] };
    expect(valueSatisfies(tree, { $ref: "#/$defs/Tree" }, defs)).toBe(true);
    expect(valueSatisfies({ value: 1 }, { $ref: "#/$defs/Tree" }, defs)).toBe(false);
  });
});
