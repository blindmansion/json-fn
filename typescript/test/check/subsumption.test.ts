import { describe, expect, test } from "bun:test";
import { type Defs, type Schema } from "../../src/check/schema";
import { isSubschema } from "../../src/check/subsumption";

// ---------------------------------------------------------------------------
// Section C — subschema check
// ---------------------------------------------------------------------------

describe("boolean schemas (any / never)", () => {
  test("everything ⊆ any", () => {
    expect(isSubschema({ type: "string" }, true)).toBe(true);
    expect(isSubschema(false, true)).toBe(true);
  });
  test("never ⊆ everything", () => {
    expect(isSubschema(false, { type: "string" })).toBe(true);
  });
  test("any ⊄ concrete", () => {
    expect(isSubschema(true, { type: "string" })).toBe(false);
  });
  test("concrete ⊄ never", () => {
    expect(isSubschema({ type: "string" }, false)).toBe(false);
  });
});

describe("primitives", () => {
  test("reflexive", () => {
    expect(isSubschema({ type: "string" }, { type: "string" })).toBe(true);
  });
  test("integer ⊆ number", () => {
    expect(isSubschema({ type: "integer" }, { type: "number" })).toBe(true);
  });
  test("number ⊄ integer", () => {
    expect(isSubschema({ type: "number" }, { type: "integer" })).toBe(false);
  });
  test("string ⊄ number", () => {
    expect(isSubschema({ type: "string" }, { type: "number" })).toBe(false);
  });
});

describe("const / enum", () => {
  test("const ⊆ its primitive", () => {
    expect(isSubschema({ const: "hi" }, { type: "string" })).toBe(true);
    expect(isSubschema({ const: 42 }, { type: "integer" })).toBe(true);
    expect(isSubschema({ const: 4.5 }, { type: "integer" })).toBe(false);
  });
  test("enum ⊆ primitive when all members fit", () => {
    expect(isSubschema({ enum: ["a", "b"] }, { type: "string" })).toBe(true);
    expect(isSubschema({ enum: ["a", 1] }, { type: "string" })).toBe(false);
  });
  test("enum ⊆ wider enum", () => {
    expect(isSubschema({ enum: ["a", "b"] }, { enum: ["a", "b", "c"] })).toBe(true);
    expect(isSubschema({ enum: ["a", "z"] }, { enum: ["a", "b", "c"] })).toBe(false);
  });
  test("primitive ⊄ enum (infinite ⊄ finite)", () => {
    expect(isSubschema({ type: "string" }, { enum: ["a", "b"] })).toBe(false);
  });
});

describe("unions", () => {
  test("arm ⊆ union", () => {
    expect(isSubschema({ type: "number" }, { type: ["number", "null"] })).toBe(true);
  });
  test("union ⊆ union (subset of arms)", () => {
    expect(isSubschema({ type: ["number", "null"] }, { type: ["number", "null", "boolean"] })).toBe(
      true,
    );
  });
  test("union ⊄ narrower", () => {
    expect(isSubschema({ type: ["number", "null"] }, { type: "number" })).toBe(false);
  });
  test("anyOf arms", () => {
    const sup: Schema = { anyOf: [{ enum: ["auto", "none"] }, { type: "number" }] };
    expect(isSubschema({ const: "auto" }, sup)).toBe(true);
    expect(isSubschema({ type: "number" }, sup)).toBe(true);
    expect(isSubschema({ const: "other" }, sup)).toBe(false);
  });
});

describe("refinements", () => {
  test("tighter interval ⊆ looser", () => {
    expect(isSubschema({ type: "integer", minimum: 5 }, { type: "integer", minimum: 0 })).toBe(
      true,
    );
    expect(isSubschema({ type: "integer", minimum: 0 }, { type: "integer", minimum: 5 })).toBe(
      false,
    );
  });
  test("bounded ⊆ unbounded but not vice versa", () => {
    expect(isSubschema({ type: "integer", minimum: 0 }, { type: "integer" })).toBe(true);
    expect(isSubschema({ type: "integer" }, { type: "integer", minimum: 0 })).toBe(false);
  });
  test("exclusive vs inclusive at the same bound", () => {
    expect(
      isSubschema({ type: "number", exclusiveMinimum: 0 }, { type: "number", minimum: 0 }),
    ).toBe(true);
    expect(
      isSubschema({ type: "number", minimum: 0 }, { type: "number", exclusiveMinimum: 0 }),
    ).toBe(false);
  });
  test("multipleOf divisibility", () => {
    expect(
      isSubschema({ type: "integer", multipleOf: 4 }, { type: "integer", multipleOf: 2 }),
    ).toBe(true);
    expect(
      isSubschema({ type: "integer", multipleOf: 2 }, { type: "integer", multipleOf: 4 }),
    ).toBe(false);
  });
  test("string length + pattern", () => {
    expect(isSubschema({ type: "string", minLength: 3 }, { type: "string", minLength: 1 })).toBe(
      true,
    );
    expect(isSubschema({ type: "string", pattern: "^u_" }, { type: "string" })).toBe(true);
    expect(isSubschema({ type: "string" }, { type: "string", pattern: "^u_" })).toBe(false);
  });
});

describe("arrays & tuples", () => {
  test("items covariance", () => {
    expect(
      isSubschema(
        { type: "array", items: { type: "integer" } },
        { type: "array", items: { type: "number" } },
      ),
    ).toBe(true);
    expect(
      isSubschema(
        { type: "array", items: { type: "number" } },
        { type: "array", items: { type: "integer" } },
      ),
    ).toBe(false);
  });
  test("length bounds", () => {
    expect(
      isSubschema(
        { type: "array", items: { type: "string" }, minItems: 64, maxItems: 64 },
        { type: "array", items: { type: "string" } },
      ),
    ).toBe(true);
  });
  test("tuple ⊆ array", () => {
    const tuple: Schema = {
      type: "array",
      prefixItems: [{ type: "integer" }, { type: "integer" }],
      items: false,
      minItems: 2,
    };
    expect(isSubschema(tuple, { type: "array", items: { type: "integer" } })).toBe(true);
    expect(isSubschema(tuple, { type: "array", items: { type: "string" } })).toBe(false);
  });
  test("tuple ⊆ tuple pointwise", () => {
    const sub: Schema = {
      type: "array",
      prefixItems: [{ type: "integer" }, { const: "x" }],
      items: false,
      minItems: 2,
    };
    const sup: Schema = {
      type: "array",
      prefixItems: [{ type: "number" }, { type: "string" }],
      items: false,
      minItems: 2,
    };
    expect(isSubschema(sub, sup)).toBe(true);
  });
});

describe("objects", () => {
  const user = (): Schema => ({
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id", "name"],
    additionalProperties: false,
  });

  test("reflexive", () => {
    expect(isSubschema(user(), user())).toBe(true);
  });
  test("extra required property ⊆ fewer requirements", () => {
    const sup: Schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    // sub additionally requires `name`, which sup's closed shape forbids.
    expect(isSubschema(user(), sup)).toBe(false);
  });
  test("closed ⊆ open", () => {
    const sub: Schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    const sup: Schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    expect(isSubschema(sub, sup)).toBe(true);
    expect(isSubschema(sup, sub)).toBe(false);
  });
  test("property type must be compatible", () => {
    const sub: Schema = {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    };
    const sup: Schema = {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    };
    expect(isSubschema(sub, sup)).toBe(true);
    expect(isSubschema(sup, sub)).toBe(false);
  });
  test("map objects", () => {
    const subMap: Schema = { type: "object", additionalProperties: { type: "integer" } };
    const supMap: Schema = { type: "object", additionalProperties: { type: "number" } };
    expect(isSubschema(subMap, supMap)).toBe(true);
    expect(isSubschema(supMap, subMap)).toBe(false);
  });
});

describe("function types", () => {
  const fn = (params: Schema[], returns: Schema): Schema => ({ $fnType: { params, returns } });

  test("return covariance", () => {
    expect(isSubschema(fn([], { type: "integer" }), fn([], { type: "number" }))).toBe(true);
    expect(isSubschema(fn([], { type: "number" }), fn([], { type: "integer" }))).toBe(false);
  });
  test("param contravariance", () => {
    // (number) -> x  ⊆  (integer) -> x
    expect(isSubschema(fn([{ type: "number" }], true), fn([{ type: "integer" }], true))).toBe(true);
    expect(isSubschema(fn([{ type: "integer" }], true), fn([{ type: "number" }], true))).toBe(
      false,
    );
  });
  test("arity is strict in v1", () => {
    expect(isSubschema(fn([], true), fn([{ type: "number" }], true))).toBe(false);
  });
});

describe("named types & recursion (via $defs)", () => {
  const defs: Defs = {
    UserId: { type: "string", pattern: "^u_" },
    Tree: {
      type: "object",
      properties: {
        value: { type: "number" },
        children: { type: "array", items: { $ref: "#/$defs/Tree" } },
      },
      required: ["value", "children"],
      additionalProperties: false,
    },
    Json: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/Json" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/Json" } },
      ],
    },
  };

  test("ref resolves against defs", () => {
    expect(isSubschema({ $ref: "#/$defs/UserId" }, { type: "string" }, defs)).toBe(true);
    expect(isSubschema({ type: "string" }, { $ref: "#/$defs/UserId" }, defs)).toBe(false);
  });
  test("recursive type is reflexive (coinductive guard terminates)", () => {
    expect(isSubschema({ $ref: "#/$defs/Tree" }, { $ref: "#/$defs/Tree" }, defs)).toBe(true);
    expect(isSubschema({ $ref: "#/$defs/Json" }, { $ref: "#/$defs/Json" }, defs)).toBe(true);
  });
});
