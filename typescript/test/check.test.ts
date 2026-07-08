import { describe, expect, test } from "bun:test";
import {
  checkExpr,
  checkModule,
  classifySchema,
  isSubschema,
  nodeKind,
  SchemaKind,
  synth,
  valueSatisfies,
} from "../src/check";
import type { CheckContext, Defs, Schema } from "../src/check";
import type { JSONType } from "../src/types";

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

// ---------------------------------------------------------------------------
// Section E — nodeKind classifier
// ---------------------------------------------------------------------------

describe("nodeKind", () => {
  const cases: [string, JSONType, ReturnType<typeof nodeKind>][] = [
    ["scalar (number)", 42, "scalar"],
    ["scalar (null)", null, "scalar"],
    ["array literal", [1, 2], "array"],
    ["var", { $var: "x" }, "var"],
    ["call", { $call: "f", $args: [] }, "call"],
    ["fn reference", { $fn: "f" }, "ref"],
    ["function body", { $params: ["x"], $return: { $var: "x" } }, "body"],
    ["if", { $if: true, $then: 1, $else: 2 }, "if"],
    ["cond", { $cond: [[true, 1]], $else: 2 }, "cond"],
    ["match", { $match: 1, $cases: [[1, "a"]], $else: "b" }, "match"],
    ["and", { $and: [true, false] }, "and"],
    ["or", { $or: [true, false] }, "or"],
    ["get", { $get: "k", $from: { $var: "o" } }, "get"],
    ["raw", { $raw: { $var: "not-evaluated" } }, "raw"],
    ["object literal", { a: 1, b: 2 }, "object"],
  ];
  for (const [name, node, kind] of cases) {
    test(name, () => expect(nodeKind(node)).toBe(kind));
  }
});

// ---------------------------------------------------------------------------
// Section E — synth (standalone expressions via checkExpr)
// ---------------------------------------------------------------------------

describe("synth: literals & data", () => {
  test("scalars synthesize as const (null as type)", () => {
    expect(checkExpr(42).type).toEqual({ const: 42 });
    expect(checkExpr("active").type).toEqual({ const: "active" });
    expect(checkExpr(true).type).toEqual({ const: true });
    expect(checkExpr(null).type).toEqual({ type: "null" });
  });
  test("array literal synthesizes as a closed tuple", () => {
    expect(checkExpr([1, 2]).type).toEqual({
      type: "array",
      prefixItems: [{ const: 1 }, { const: 2 }],
      items: false,
      minItems: 2,
    });
  });
  test("object literal synthesizes as a closed object", () => {
    expect(checkExpr({ from: 1, to: 2 }).type).toEqual({
      type: "object",
      properties: { from: { const: 1 }, to: { const: 2 } },
      required: ["from", "to"],
      additionalProperties: false,
    });
  });
  test("$raw payload is typed structurally, not evaluated", () => {
    expect(checkExpr({ $raw: { $var: "x" } }).type).toEqual({
      type: "object",
      properties: { $var: { const: "x" } },
      required: ["$var"],
      additionalProperties: false,
    });
  });
  test("a synthesized literal is a subtype of its declared refinement", () => {
    expect(isSubschema(checkExpr(5).type, { type: "integer", minimum: 0 })).toBe(true);
    expect(isSubschema(checkExpr(-5).type, { type: "integer", minimum: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sections D + E + G — module checking end to end
// ---------------------------------------------------------------------------

// Convenience: a `$sig`-annotated function body.
const body = (
  params: JSONType[],
  sig: { params: Schema[]; returns: Schema; rest?: Schema },
  ret: JSONType,
  locals: Record<string, JSONType> = {},
): Record<string, JSONType> => ({ $sig: sig, $params: params, ...locals, $return: ret });

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };

describe("checkModule: clean programs", () => {
  test("identity + a caller through the registry sig type-check", () => {
    const mod = {
      identity: body(["n"], { params: [I], returns: I }, { $var: "n" }),
      caller: body(
        ["n"],
        { params: [I], returns: I },
        { $call: "identity", $args: [{ $var: "n" }] },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("a $cond over literal results fits a string return", () => {
    const mod = {
      label: body(
        ["n"],
        { params: [I], returns: S },
        {
          $cond: [[{ $var: "n" }, "a"]],
          $else: "b",
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("$get projects a declared property type", () => {
    const mod = {
      $types: {
        Color: { enum: ["w", "b"] },
        State: {
          type: "object",
          properties: { board: { type: "array", items: I }, turn: { $ref: "#/$defs/Color" } },
          required: ["board", "turn"],
          additionalProperties: false,
        },
      },
      getTurn: body(
        ["s"],
        { params: [{ $ref: "#/$defs/State" }], returns: { $ref: "#/$defs/Color" } },
        {
          $get: "turn",
          $from: { $var: "s" },
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });
});

describe("checkModule: diagnostics", () => {
  test("return type mismatch is reported", () => {
    const mod = {
      bad: body(["n"], { params: [I], returns: S }, { $var: "n" }),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["bad", "$return"]);
    expect(diags[0]!.expected).toEqual(S);
    expect(diags[0]!.actual).toEqual(I);
  });

  test("argument type mismatch is reported at the arg path", () => {
    const mod = {
      wantString: body(["s"], { params: [S], returns: S }, { $var: "s" }),
      caller: body(
        ["n"],
        { params: [I], returns: S },
        {
          $call: "wantString",
          $args: [{ $var: "n" }],
        },
      ),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["caller", "$return", "$args[0]"]);
  });

  test("arity mismatch is reported", () => {
    const mod = {
      identity: body(["n"], { params: [I], returns: I }, { $var: "n" }),
      caller: body(
        ["n"],
        { params: [I], returns: I },
        {
          $call: "identity",
          $args: [{ $var: "n" }, { $var: "n" }],
        },
      ),
    };
    const diags = checkModule(mod);
    expect(diags.some((d) => /Expected 1 argument/.test(d.message))).toBe(true);
  });

  test("rest params accept extra arguments of the element type", () => {
    const mod = {
      variadic: body(["...xs"], { params: [], rest: I, returns: I }, 0),
      caller: body([], { params: [], returns: I }, { $call: "variadic", $args: [1, 2, 3] }),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("a rest arg of the wrong element type is reported", () => {
    const mod = {
      variadic: body(["...xs"], { params: [], rest: I, returns: I }, 0),
      caller: body([], { params: [], returns: I }, { $call: "variadic", $args: [1, "two"] }),
    };
    const diags = checkModule(mod);
    expect(diags.some((d) => d.path.join(".") === "caller.$return.$args[1]")).toBe(true);
  });
});

describe("buildTypeScope: lazy locals & cycles", () => {
  test("an un-annotated local is typed lazily from its expression", () => {
    // `doubled` is a where-local with no signature; its type is synthesized on
    // demand and must fit the declared return.
    const mod = {
      f: body(
        ["n"],
        { params: [I], returns: I },
        { $var: "chosen" },
        {
          chosen: { $var: "n" },
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("mutually recursive locals are caught as a cycle", () => {
    const mod = { a: { $var: "b" }, b: { $var: "a" } };
    const diags = checkModule(mod);
    expect(diags.some((d) => /Circular local type dependency/.test(d.message))).toBe(true);
  });
});

describe("synth: control-flow unions", () => {
  test("$if synthesizes the union of its branches", () => {
    const ctx: CheckContext = {
      defs: {},
      env: { lookupType: () => undefined },
      diagnostics: [],
      path: [],
    };
    const t = synth({ $if: true, $then: 1, $else: "x" }, ctx);
    expect(t).toEqual({ anyOf: [{ const: 1 }, { const: "x" }] });
  });
});
