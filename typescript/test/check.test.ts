import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../src/builtins";
import type { JSONType } from "../src/types";
import { classifySchema, SchemaKind, type Defs, type Schema } from "../src/check/schema";
import { isSubschema } from "../src/check/subsumption";
import { valueSatisfies } from "../src/check/values";
import { nodeKind } from "../src/check/ast";
import { checkExpr, checkModule } from "../src/check/module";
import { synth } from "../src/check/checker";
import type { CheckContext } from "../src/check/context";
import { createStdlib } from "../src/stdlib";

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
    expect(diags[0]!.severity).toBe("error");
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

// ---------------------------------------------------------------------------
// Section F — builtin signatures (the spec/builtins.json dialect, end to end)
// ---------------------------------------------------------------------------

describe("Section F — builtin signatures", () => {
  const BT = loadBuiltinTable();
  const call = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const arrOfInt: Schema = { type: "array", items: { type: "integer" } };
  const synthB = (expr: JSONType) => checkExpr(expr, {}, BT);

  test("builtins are opt-in: no table means degrade to any", () => {
    expect(checkExpr(call("add", 1, 2)).type).toBe(true);
  });

  test("overloads: add preserves integer, widens to number", () => {
    expect(synthB(call("add", 1, 2)).type).toEqual({ type: "integer" });
    expect(synthB(call("add", 1.5, 2)).type).toEqual({ type: "number" });
  });

  test("overloads: length accepts arrays and strings", () => {
    expect(synthB(call("length", [1, 2, 3])).type).toEqual({ type: "integer" });
    expect(synthB(call("length", "hello")).type).toEqual({ type: "integer" });
  });

  test("a no-overload-fits call reports a diagnostic", () => {
    // gt : (number, number) -> boolean; strings fit neither overload.
    expect(synthB(call("gt", "a", "b")).diagnostics.length).toBeGreaterThan(0);
  });

  test("type variables: head returns T | null", () => {
    const { type } = synthB(call("head", [1, 2, 3]));
    expect(isSubschema(type, { type: ["integer", "null"] })).toBe(true);
  });

  test("type variables: concat and setAt preserve the element type", () => {
    expect(isSubschema(synthB(call("concat", [1, 2], [3, 4])).type, arrOfInt)).toBe(true);
    expect(isSubschema(synthB(call("setAt", [1, 2, 3], 0, 9)).type, arrOfInt)).toBe(true);
  });

  test("named $defs type + union return: reMatch", () => {
    expect(synthB(call("reMatch", "a", "b")).type).toEqual({
      anyOf: [{ $ref: "#/$defs/Match" }, { type: "null" }],
    });
  });

  test("escape hatch: a rule builtin yields any", () => {
    expect(synthB(call("pipe", [], 1)).type).toBe(true);
  });

  test("coverage: every stdlib builtin has a table entry", () => {
    const missing = Object.keys(createStdlib()).filter((name) => !(name in BT.builtins));
    expect(missing).toEqual([]);
  });

  describe("tier 1 — monomorphic & concrete overloads", () => {
    test("max/min preserve integer and widen to number", () => {
      expect(synthB(call("max", [1, 2, 3])).type).toEqual({ type: "integer" });
      expect(synthB(call("min", [1.5, 2])).type).toEqual({ type: "number" });
    });

    test("num/isTask/arity have concrete returns", () => {
      expect(synthB(call("num", "5")).type).toEqual({ type: "number" });
      expect(synthB(call("isTask", 1)).type).toEqual({ type: "boolean" });
      expect(isSubschema(synthB(call("arity", 1)).type, { type: ["integer", "null"] })).toBe(true);
    });

    test("range/split/join/strcat", () => {
      expect(isSubschema(synthB(call("range", 5)).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("split", "a,b", ",")).type, { type: "array", items: S })).toBe(
        true,
      );
      expect(synthB(call("join", ["a", "b"], ",")).type).toEqual(S);
      expect(synthB(call("strcat", "a", "b", "c")).type).toEqual(S);
    });

    test("strcat rejects a non-string arg", () => {
      expect(synthB(call("strcat", "a", 1)).diagnostics.length).toBeGreaterThan(0);
    });

    test("regex families: reTest/reMatchAll/reReplace/reSplit", () => {
      expect(synthB(call("reTest", "a", "b")).type).toEqual({ type: "boolean" });
      expect(synthB(call("reMatchAll", "a", "b")).type).toEqual({
        type: "array",
        items: { $ref: "#/$defs/Match" },
      });
      expect(synthB(call("reReplace", "a", "b", "c")).type).toEqual(S);
      expect(isSubschema(synthB(call("reSplit", "a", "b")).type, { type: "array", items: S })).toBe(
        true,
      );
    });

    test("log is identity on its value (both overloads)", () => {
      expect(synthB(call("log", "hi")).type).toEqual({ const: "hi" });
      expect(synthB(call("log", "hi", "label")).type).toEqual({ const: "hi" });
    });
  });

  describe("tier 2 — array generics", () => {
    test("last is T | null; tail/reverse are T[]", () => {
      expect(isSubschema(synthB(call("last", [1, 2, 3])).type, { type: ["integer", "null"] })).toBe(
        true,
      );
      expect(isSubschema(synthB(call("tail", [1, 2, 3])).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("reverse", [1, 2, 3])).type, arrOfInt)).toBe(true);
    });

    test("flatten unwraps one array level", () => {
      // A literal `[[1,2],[3]]` synthesizes to a *tuple of tuples*, which the
      // engine can't destructure; build a real `integer[][]` via map/range.
      const nested = call(
        "map",
        { $params: ["n", "i"], $return: call("range", { $var: "n" }) },
        [1, 2, 3],
      );
      expect(isSubschema(synthB(call("flatten", nested)).type, arrOfInt)).toBe(true);
    });

    test("slice: array arm stays generic, string arm returns string", () => {
      expect(isSubschema(synthB(call("slice", [1, 2, 3], 1)).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("slice", [1, 2, 3], 1, 2)).type, arrOfInt)).toBe(true);
      expect(synthB(call("slice", "hello", 1)).type).toEqual(S);
      expect(synthB(call("slice", "hello", 1, 3)).type).toEqual(S);
    });

    test("includes/indexOf pick the right arm", () => {
      expect(synthB(call("includes", [1, 2, 3], 2)).type).toEqual({ type: "boolean" });
      expect(synthB(call("includes", "hi", "h")).type).toEqual({ type: "boolean" });
      expect(synthB(call("indexOf", [1, 2, 3], 2)).type).toEqual({ type: "integer" });
      expect(synthB(call("indexOf", "hi", "h")).type).toEqual({ type: "integer" });
    });
  });

  describe("tier 3 — higher-order builtins", () => {
    test("reduce infers U from init and threads the accumulator", () => {
      const sum = {
        $params: ["acc", "n", "i"],
        $return: call("add", { $var: "acc" }, { $var: "n" }),
      };
      const r = synthB(call("reduce", sum, 0, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      // U joins the literal init `0` with the accumulator return, so the result
      // is (equivalent to) integer — not pinned to the narrow `const 0`.
      expect(isSubschema(r.type, I) && isSubschema(I, r.type)).toBe(true);
    });

    test("find is T | null; findIndex/some/every are integer/boolean", () => {
      const gtOne = { $params: ["n", "i"], $return: call("gt", { $var: "n" }, 1) };
      expect(
        isSubschema(synthB(call("find", gtOne, [1, 2, 3])).type, { type: ["integer", "null"] }),
      ).toBe(true);
      expect(synthB(call("findIndex", gtOne, [1, 2, 3])).type).toEqual({ type: "integer" });
      expect(synthB(call("some", gtOne, [1, 2, 3])).type).toEqual({ type: "boolean" });
      expect(synthB(call("every", gtOne, [1, 2, 3])).type).toEqual({ type: "boolean" });
    });

    test("sort/sortBy preserve the element type", () => {
      const cmp = { $params: ["a", "b"], $return: call("sub", { $var: "a" }, { $var: "b" }) };
      expect(isSubschema(synthB(call("sort", cmp, [3, 1, 2])).type, arrOfInt)).toBe(true);
      const keyFn = { $params: ["n", "i"], $return: { $var: "n" } };
      expect(isSubschema(synthB(call("sortBy", keyFn, [3, 1, 2])).type, arrOfInt)).toBe(true);
    });

    test("groupBy returns a map of T[]", () => {
      const keyFn = { $params: ["n", "i"], $return: call("str", { $var: "n" }) };
      const r = synthB(call("groupBy", keyFn, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, { type: "object", additionalProperties: arrOfInt })).toBe(true);
    });

    test("flatMap infers U from the callback's array return", () => {
      const dup = {
        $params: ["n", "i"],
        $return: call("concat", [{ $var: "n" }], [{ $var: "n" }]),
      };
      const r = synthB(call("flatMap", dup, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("reReplaceWith types its Match callback", () => {
      const cb = { $params: ["m"], $return: { $get: "match", $from: { $var: "m" } } };
      const r = synthB(call("reReplaceWith", "a", cb, "banana"));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(S);
    });
  });

  describe("tier 4 — object utilities & effect rules", () => {
    test("keys returns string[]; values/entries return arrays", () => {
      const obj = { a: 1, b: 2 };
      expect(isSubschema(synthB(call("keys", obj)).type, { type: "array", items: S })).toBe(true);
      expect(classifySchema(synthB(call("values", obj)).type)).toBe(SchemaKind.Array);
      expect(classifySchema(synthB(call("entries", obj)).type)).toBe(SchemaKind.Array);
    });

    test("merge/pick/omit/mapValues return objects; hasKey a boolean", () => {
      const obj = { a: 1, b: 2 };
      expect(classifySchema(synthB(call("merge", obj, { c: 3 })).type)).toBe(SchemaKind.Object);
      expect(classifySchema(synthB(call("pick", obj, ["a"])).type)).toBe(SchemaKind.Object);
      expect(classifySchema(synthB(call("omit", obj, ["a"])).type)).toBe(SchemaKind.Object);
      expect(synthB(call("hasKey", obj, "a")).type).toEqual({ type: "boolean" });
      const inc = { $params: ["v", "k"], $return: call("add", { $var: "v" }, 1) };
      expect(classifySchema(synthB(call("mapValues", inc, obj)).type)).toBe(SchemaKind.Object);
    });

    test("effect constructors and apply are rule escape hatches (any)", () => {
      expect(synthB(call("perform", "read", [])).type).toBe(true);
      expect(synthB(call("pure", 1)).type).toBe(true);
      expect(synthB(call("raise", "boom")).type).toBe(true);
      expect(synthB(call("apply", { $params: ["n"], $return: { $var: "n" } }, [1])).type).toBe(
        true,
      );
    });
  });

  describe("contextual lambda typing", () => {
    test("map infers T from the array and U from the callback return", () => {
      const identity = { $params: ["n"], $return: { $var: "n" } };
      const r = synthB(call("map", identity, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("map callback bodies resolve nested builtins under the pushed param type", () => {
      const addOne = { $params: ["n"], $return: call("add", { $var: "n" }, 1) };
      const r = synthB(call("map", addOne, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("filter accepts a boolean-returning callback", () => {
      const gtOne = { $params: ["n"], $return: call("gt", { $var: "n" }, 1) };
      const r = synthB(call("filter", gtOne, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("filter reports a non-boolean callback return", () => {
      const bad = { $params: ["n"], $return: { $var: "n" } };
      const r = synthB(call("filter", bad, [1, 2, 3]));
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics.some((d) => d.path.join(".") === "$args[0].$return")).toBe(true);
    });

    test("a lambda at a non-function param position reports, not throws", () => {
      // Swapped args: the lambda lands on `map`'s array param. Previously this
      // destructured an absent `$fnType` and threw; it must be a diagnostic.
      const lambda = { $params: ["n"], $return: call("add", { $var: "n" }, 1) };
      const r = synthB(call("map", [1, 2, 3], lambda));
      expect(r.diagnostics.some((d) => d.path.join(".") === "$args[1]")).toBe(true);
      expect(r.diagnostics.some((d) => d.severity === "error")).toBe(true);
    });
  });

  describe("through the module checker", () => {
    test("map/add flow an integer[] cleanly to a declared integer[] return", () => {
      const mod = {
        doubleAll: body(
          ["xs"],
          { params: [arrOfInt], returns: arrOfInt },
          call(
            "map",
            { $params: ["n"], $return: call("add", { $var: "n" }, { $var: "n" }) },
            {
              $var: "xs",
            },
          ),
        ),
      };
      expect(checkModule(mod, BT)).toEqual([]);
    });

    test("a builtin result that mismatches the declared return is reported", () => {
      const strArr: Schema = { type: "array", items: S };
      const mod = {
        wrong: body(
          ["xs"],
          { params: [arrOfInt], returns: strArr },
          call("map", { $params: ["n"], $return: { $var: "n" } }, { $var: "xs" }),
        ),
      };
      const diags = checkModule(mod, BT);
      expect(diags.length).toBeGreaterThan(0);
      expect(diags[0]!.path).toEqual(["wrong", "$return"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Real-program fragments: the chess example, worked up in tiers.
//
// Rather than hand-annotate the whole 40-function module at once, we build up
// from the smallest self-contained pieces. Each tier exercises the checker (and
// the builtin table) against code that actually appears in `examples/chess.jfn`,
// lowered to canonical JSON with `$sig`s and a module `$types` pool added.
//
// Tier 1 — the pure coordinate layer: integer/boolean arithmetic with no
// nullability and no name-union dispatch. This is the cleanest slice and should
// type with zero diagnostics.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 1: coordinate layer", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const B: Schema = { type: "boolean" };
  const Color: Schema = { $ref: "#/$defs/Color" };
  const types: Defs = { Color: { enum: ["w", "b"] } };

  const v = (name: string): JSONType => ({ $var: name });

  test("rowOf: floor(idx / 8) : integer", () => {
    const mod = {
      $types: types,
      rowOf: body(["idx"], { params: [I], returns: I }, c("floor", c("div", v("idx"), 8))),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("colOf: idx % 8 preserves integer", () => {
    const mod = {
      $types: types,
      colOf: body(["idx"], { params: [I], returns: I }, c("mod", v("idx"), 8)),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("toIdx: row * 8 + col preserves integer through mul/add", () => {
    const mod = {
      $types: types,
      toIdx: body(
        ["row", "col"],
        { params: [I, I], returns: I },
        c("add", c("mul", v("row"), 8), v("col")),
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("inBounds: a variadic $and of comparisons is boolean", () => {
    const mod = {
      $types: types,
      inBounds: body(
        ["row", "col"],
        { params: [I, I], returns: B },
        {
          $and: [
            c("gte", v("row"), 0),
            c("lte", v("row"), 7),
            c("gte", v("col"), 0),
            c("lte", v("col"), 7),
          ],
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("otherColor: an if over string literals fits the Color enum", () => {
    const mod = {
      $types: types,
      otherColor: body(
        ["color"],
        { params: [Color], returns: Color },
        { $if: c("eq", v("color"), "w"), $then: "b", $else: "w" },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("the whole coordinate layer checks together, cleanly", () => {
    const mod = {
      $types: types,
      rowOf: body(["idx"], { params: [I], returns: I }, c("floor", c("div", v("idx"), 8))),
      colOf: body(["idx"], { params: [I], returns: I }, c("mod", v("idx"), 8)),
      toIdx: body(
        ["row", "col"],
        { params: [I, I], returns: I },
        c("add", c("mul", v("row"), 8), v("col")),
      ),
      inBounds: body(
        ["row", "col"],
        { params: [I, I], returns: B },
        {
          $and: [
            c("gte", v("row"), 0),
            c("lte", v("row"), 7),
            c("gte", v("col"), 0),
            c("lte", v("col"), 7),
          ],
        },
      ),
      otherColor: body(
        ["color"],
        { params: [Color], returns: Color },
        { $if: c("eq", v("color"), "w"), $then: "b", $else: "w" },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — nullability and the narrowing wall (§5.5).
//
// The chess piece layer works over `Cell = Piece | null`. The idiom is
// guard-then-use: `if isNull(piece) then ... else <use piece as a string>`.
// The `else` branch is only reached when `piece` is non-null, but the checker
// performs *no flow narrowing* yet — so `piece` keeps its declared `Cell` type
// inside the branch and a `string`-expecting builtin sees `Piece | null`.
//
// Milestone 1 (§5.5 option 2) now does *real* flow narrowing for the tractable
// case — the guarded subject is a bare `$var` (param or eager local) and the
// fact holds within one `$if`/`$cond`/`$match` arm. So `pieceColor`'s
// `isNull(piece)` guard narrows `piece` from `Cell` to `Piece` in the
// else-branch, and `upper(piece)` type-checks clean. Cases narrowing *can't*
// reach (a builtin-result precision loss like `makePiece`) still land on the
// M0 warning path; genuinely disjoint mismatches stay hard errors.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 2: nullability & narrowing", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const v = (name: string): JSONType => ({ $var: name });
  const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  const Color: Schema = { $ref: "#/$defs/Color" };
  const Cell: Schema = { $ref: "#/$defs/Cell" };
  const Piece: Schema = { $ref: "#/$defs/Piece" };
  const PieceType: Schema = { $ref: "#/$defs/PieceType" };
  const ColorOrNull: Schema = { anyOf: [Color, { type: "null" }] };

  const types: Defs = {
    Color: { enum: ["w", "b"] },
    Piece: { enum: ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] },
    PieceType: { enum: ["P", "N", "B", "R", "Q", "K"] },
    Cell: { anyOf: [{ $ref: "#/$defs/Piece" }, { type: "null" }] },
  };

  test("isNull accepts a Cell and yields boolean (the guard itself is fine)", () => {
    const mod = {
      $types: types,
      isEmpty: body(
        ["piece"],
        { params: [Cell], returns: { type: "boolean" } },
        c("isNull", v("piece")),
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("pieceColor: isNull(piece) narrows Cell to Piece in the else-branch (§5.5 M1)", () => {
    // (piece: Cell) => if isNull(piece) then null
    //                  else if piece == upper(piece) then "w" else "b"
    const mod = {
      $types: types,
      pieceColor: body(
        ["piece"],
        { params: [Cell], returns: ColorOrNull },
        {
          $if: c("isNull", v("piece")),
          $then: null,
          $else: {
            $if: c("eq", v("piece"), c("upper", v("piece"))),
            $then: "w",
            $else: "b",
          },
        },
      ),
    };
    // The `isNull` guard proves `piece : Piece` on the else-branch, so
    // `upper(piece)` (Piece ⊆ string) type-checks clean — zero diagnostics.
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test('negative narrowing: eq(color, "w") excludes the literal on the else-branch', () => {
    // (color: Color) => if color == "w" then "first" else <use narrowed color>
    // On the else-branch `color` is narrowed to the `Color` enum minus "w",
    // i.e. the const "b", which still fits the declared `Color` return.
    const mod = {
      $types: types,
      afterWhite: body(
        ["color"],
        { params: [Color], returns: Color },
        { $if: c("eq", v("color"), "w"), $then: "b", $else: v("color") },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("narrowed var feeds a field projection: isNull(sq) guard unlocks sq.file", () => {
    // (sq: Square | null) => if isNull(sq) then 0 else sq.file
    // Without narrowing, the else-branch target is `Square | null` (a union, not
    // an object), so `$get "file"` degrades to `any` and `any ⊄ integer` fires.
    // The `isNull` guard narrows `sq` to `Square`, so the projection yields the
    // declared `file : integer` and the module is clean — an observable proof
    // that narrowing feeds `$get`.
    const Square: Schema = {
      type: "object",
      properties: { file: I, rank: I },
      required: ["file", "rank"],
      additionalProperties: false,
    };
    const NullableSquare: Schema = { anyOf: [Square, { type: "null" }] };
    const mod = {
      $types: types,
      fileOf: body(
        ["sq"],
        { params: [NullableSquare], returns: I },
        {
          $if: c("isNull", v("sq")),
          $then: 0,
          $else: { $get: "file", $from: v("sq") },
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("makePiece: lower(type) widens the enum to `string`, losing ⊆ Piece (§5.3 precision)", () => {
    // (color: Color, type: PieceType) => if color == "w" then type else lower(type)
    // The argument `lower(type)` type-checks (PieceType ⊆ string), but `lower`'s
    // result schema is the generic `string`, so the `if` union
    // `PieceType | string` no longer fits the declared `Piece` return. This is a
    // *builtin result precision* limit, distinct from the narrowing wall above —
    // but it too overlaps `Piece` (the `PieceType` arm fits), so M0 downgrades it
    // to a warning rather than a hard error.
    const mod = {
      $types: types,
      makePiece: body(
        ["color", "type"],
        { params: [Color, PieceType], returns: Piece },
        {
          $if: c("eq", v("color"), "w"),
          $then: v("type"),
          $else: c("lower", v("type")),
        },
      ),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.path).toEqual(["makePiece", "$return"]);
    expect(eqJson(diags[0]!.expected, Piece)).toBe(true);
  });

  test("a disjoint mismatch stays a hard error (the predicate discriminates)", () => {
    // Return an `integer` (length's result) where a `Color` enum is declared. No
    // arm of `integer` fits `Color`, so the types are disjoint and this is a
    // genuine error, not a runtime-checkable warning.
    const mod = {
      $types: types,
      bad: body(["color"], { params: [Color], returns: Color }, c("length", "abc")),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["bad", "$return"]);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — lazy-local narrowing at forcing sites (§5.5 M2).
//
// The bulk of real chess narrows a value that flows *through* a where-local,
// not the guarded var directly:
//   * `pieceMoves`: `type`/`color` are lazy locals bound from `piece`; they are
//     forced only inside the non-null (`else`) arm, so re-synthesizing them
//     under the guard's fact is sound and clean.
//   * `slideDir`: the arms of a `$cond` are guarded by *named boolean locals*
//     (`empty: isNull(target)`, `ok: not(empty)`), not inline predicates.
//
// M2 threads the forcing site's facts into lazy-local resolution behind a
// free-variable gate (the no-narrowing path is byte-identical), re-synthesizes
// a dependent local under the *relevant* facts with a fact-keyed cache, and
// teaches `factsFromCondition` to recurse through a boolean-guard local.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 3: lazy-local & boolean-guard narrowing (§5.5 M2)", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const v = (name: string): JSONType => ({ $var: name });

  const Cell: Schema = { $ref: "#/$defs/Cell" };
  const StringOrNull: Schema = { anyOf: [S, { type: "null" }] };
  const StringArray: Schema = { type: "array", items: S };

  const types: Defs = {
    Color: { enum: ["w", "b"] },
    Piece: { enum: ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] },
    Cell: { anyOf: [{ $ref: "#/$defs/Piece" }, { type: "null" }] },
  };

  test("pieceMoves: locals bound from a guarded var narrow at their forcing site", () => {
    // (piece: Cell) => if isNull(piece) then [] else [type, color]
    //   where type = upper(piece), color = lower(piece)
    // `type`/`color` reference `piece` but are forced *only* in the non-null
    // else-arm. Under M1 they were synthesized once, un-narrowed, so
    // `upper(Cell)` warned (Cell ⊄ string). M2 re-synthesizes them under the
    // guard's `piece : Piece` fact (indirect narrowing through the free-var
    // gate), so both fit `string` and the module is clean.
    const mod = {
      $types: types,
      pieceMoves: body(
        ["piece"],
        { params: [Cell], returns: StringArray },
        { $if: c("isNull", v("piece")), $then: [], $else: [v("type"), v("color")] },
        { type: c("upper", v("piece")), color: c("lower", v("piece")) },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("slideDir: a $cond guarded by named boolean locals narrows the else-arm (§2.3)", () => {
    // (target: Cell) => cond { !ok -> null, empty -> null, else -> upper(target) }
    //   where empty = isNull(target), ok = not(empty)   // alias depth 2
    // The else-arm is reached only when every guard is false, which the boolean
    // aliases prove implies `target : Piece`. `factsFromCondition` recurses
    // through `ok -> not(empty) -> isNull(target)` to learn that, so
    // `upper(target)` type-checks clean.
    const mod = {
      $types: types,
      slideDir: body(
        ["target"],
        { params: [Cell], returns: StringOrNull },
        {
          $cond: [
            [c("not", v("ok")), null],
            [v("empty"), null],
          ],
          $else: c("upper", v("target")),
        },
        { empty: c("isNull", v("target")), ok: c("not", v("empty")) },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("parseMove: !isNull(from) && !isNull(to) narrows both before object construction", () => {
    // (from: Cell, to: Cell) => if !isNull(from) && !isNull(to)
    //                           then { from, to } else null
    // The conjunction narrows both vars to `Piece` on the then-arm, so the
    // constructed object fits the non-null `Move` shape.
    const Move: Schema = {
      type: "object",
      properties: { from: { $ref: "#/$defs/Piece" }, to: { $ref: "#/$defs/Piece" } },
      required: ["from", "to"],
      additionalProperties: false,
    };
    const mod = {
      $types: types,
      parseMove: body(
        ["from", "to"],
        { params: [Cell, Cell], returns: { anyOf: [Move, { type: "null" }] } },
        {
          $if: { $and: [c("not", c("isNull", v("from"))), c("not", c("isNull", v("to")))] },
          $then: { from: v("from"), to: v("to") },
          $else: null,
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("per-arm divergence: a local re-synthesizes per fact set, with dedup'd diagnostics", () => {
    // (p: Color, q: Cell) => match p { "w" -> d } else d
    //   where d = [upper(q), p]
    // `d` is forced under two distinct facts — p : "w" (case) and p : "b"
    // (else). The memo split gives `d` two element types ("w" vs "b"), whose
    // union no longer fits the declared `[string, "w"]` return → one return
    // warning (absent if the two arms had collapsed onto one memo). Meanwhile
    // `upper(q)` (q never narrowed) warns inside *each* re-synth of `d`, but the
    // two are structurally identical, so the end-of-module dedupe keeps one.
    const Color: Schema = { $ref: "#/$defs/Color" };
    const mod = {
      $types: types,
      divergent: body(
        ["p", "q"],
        {
          params: [Color, Cell],
          returns: { type: "array", prefixItems: [S, { const: "w" }], items: false, minItems: 2 },
        },
        { $match: v("p"), $cases: [["w", v("d")]], $else: v("d") },
        { d: [c("upper", v("q")), v("p")] },
      ),
    };
    const diags = checkModule(mod, BT);
    // Exactly two: 1 (not 3) means the duplicate `upper(q)` warning was deduped;
    // 2 (not 1) means the else-arm re-synthesized `d` under its own fact.
    expect(diags.length).toBe(2);
    expect(diags.every((d) => d.severity === "warning")).toBe(true);
    expect(diags.some((d) => d.path.join(".") === "divergent.$return")).toBe(true);
    expect(diags.some((d) => d.path[0] === "d")).toBe(true);
  });

  test("fast path: a module with no narrowing is unaffected by the gate/dedupe", () => {
    // A plain guard-free use: `upper(q)` on a `Cell` warns (Cell ⊄ string,
    // narrowable). No narrowing is in play, so the free-var gate returns the
    // un-narrowed memo and the dedupe is a no-op — the diagnostic is exactly the
    // single M0 warning, unchanged.
    const mod = {
      $types: types,
      plain: body(["q"], { params: [Cell], returns: S }, c("upper", v("q"))),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.path).toEqual(["plain", "$return", "$args[0]"]);
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — field-path & discriminant narrowing (§5.5 M3).
//
// M1/M2 narrow a bare `$var`. M3 extends narrowing to subjects that are
// *paths* — a field/element reached *through* a value:
//   * Nullable field: `isNull(move.from)` then `move.from` used as a `Piece`.
//     The guard subject is the path `move.from`, keyed as such on
//     `ctx.narrowings` and read back at the `$get` projection site.
//   * Discriminated union: `s.tag == "circle"` narrows `s` to the union arm
//     whose `tag` is `const "circle"`, so `s.r`/`s.side` project cleanly.
// The M2 re-synth machinery (free-var gate, fact-keyed cache) is reused: a lazy
// local that reaches through a narrowed path re-synthesizes under the path fact.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 4: field-path & discriminant narrowing (§5.5 M3)", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const v = (name: string): JSONType => ({ $var: name });
  const g = (key: JSONType, from: JSONType): JSONType => ({ $get: key, $from: from });

  const Piece: Schema = { $ref: "#/$defs/Piece" };
  const Cell: Schema = { $ref: "#/$defs/Cell" };
  const StringOrNull: Schema = { anyOf: [S, { type: "null" }] };
  const PieceOrNull: Schema = { anyOf: [Piece, { type: "null" }] };

  // A move whose endpoints are *nullable* piece cells (the M3 field-path case:
  // the guarded thing is `move.from`, not `move`).
  const Move: Schema = {
    type: "object",
    properties: { from: Cell, to: Cell },
    required: ["from", "to"],
    additionalProperties: false,
  };

  const types: Defs = {
    Piece: { enum: ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] },
    Cell: { anyOf: [{ $ref: "#/$defs/Piece" }, { type: "null" }] },
  };

  test("nullable field: isNull(move.from) narrows the path move.from to Piece in the else-arm", () => {
    // (move: Move) => if isNull(move.from) then null else upper(move.from)
    // Without path narrowing, `move.from : Cell` (Piece | null), `upper` wants
    // string → a narrowable warning. M3 narrows the *path* `move.from` to
    // `Piece` on the else-arm, so `upper(move.from)` type-checks clean.
    const mod = {
      $types: types,
      firstGlyph: body(
        ["move"],
        { params: [Move], returns: StringOrNull },
        {
          $if: c("isNull", g("from", v("move"))),
          $then: null,
          $else: c("upper", g("from", v("move"))),
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("discriminated union: s.tag == lit narrows s to the matching arm", () => {
    // (s: Shape) => if s.tag == "circle" then s.r else s.side
    // Without narrowing, `s` is the full union in both arms, so `s.r`/`s.side`
    // project to `any` (union isn't an object) and `any ⊄ integer` is a hard
    // error. M3 narrows `s` to the arm whose `tag` const matches, so each
    // projection yields the declared `integer`.
    const Circle: Schema = {
      type: "object",
      properties: { tag: { const: "circle" }, r: I },
      required: ["tag", "r"],
      additionalProperties: false,
    };
    const Square: Schema = {
      type: "object",
      properties: { tag: { const: "square" }, side: I },
      required: ["tag", "side"],
      additionalProperties: false,
    };
    const shapeTypes: Defs = { Shape: { anyOf: [Circle, Square] } };
    const Shape: Schema = { $ref: "#/$defs/Shape" };
    const mod = {
      $types: shapeTypes,
      area: body(
        ["s"],
        { params: [Shape], returns: I },
        {
          $if: c("eq", g("tag", v("s")), "circle"),
          $then: g("r", v("s")),
          $else: g("side", v("s")),
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("disjoint field use stays a hard error even after path narrowing", () => {
    // Narrow `move.from` to `Piece`, then feed it where an integer is wanted.
    // `Piece` is disjoint from `integer`, so this must remain a hard error —
    // path narrowing must not silence a genuine mismatch.
    const mod = {
      $types: types,
      needInt: body(["n"], { params: [I], returns: I }, v("n")),
      badField: body(
        ["move"],
        { params: [Move], returns: I },
        {
          $if: c("not", c("isNull", g("from", v("move")))),
          $then: c("needInt", g("from", v("move"))),
          $else: 0,
        },
      ),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["badField", "$return", "$then", "$args[0]"]);
  });

  test("lazy local through a path: a where-local bound from move.from narrows at forcing", () => {
    // (move: Move) => if isNull(move.from) then null else glyph
    //   where glyph = upper(move.from)
    // `glyph` reaches through the narrowed path `move.from` but is forced only
    // in the non-null else-arm. The M2 re-synth engine (free-var gate widened to
    // record path keys) re-types it under the `move.from : Piece` fact → clean.
    const mod = {
      $types: types,
      firstGlyphLocal: body(
        ["move"],
        { params: [Move], returns: StringOrNull },
        {
          $if: c("isNull", g("from", v("move"))),
          $then: null,
          $else: v("glyph"),
        },
        { glyph: c("upper", g("from", v("move"))) },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("negated field guard narrows to non-null on the then-arm", () => {
    // (move: Move) => if !isNull(move.to) then move.to else null
    // The truthy branch of `!isNull(move.to)` proves `move.to : Piece`.
    const mod = {
      $types: types,
      target: body(
        ["move"],
        { params: [Move], returns: PieceOrNull },
        {
          $if: c("not", c("isNull", g("to", v("move")))),
          $then: g("to", v("move")),
          $else: null,
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 5 — $match exhaustiveness & dead-case lints (§5.6).
//
// The exhaustiveness lint reuses the residual that narrowing already computes:
// if a `$match` subject has a *finite* set of possible values (an enum var, a
// union of consts, or a `base.field` discriminant across union arms) and the
// cases don't cover all of them with no catch-all `$else`, some input silently
// falls through — a smell, so a `warning` (not an error, since `$match` has
// runtime fall-through semantics). Conversely a case whose literal can never
// occur in the subject's universe is dead code — a separate `warning`.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 5: $match exhaustiveness & dead cases (§5.6)", () => {
  const BT = loadBuiltinTable();
  const v = (name: string): JSONType => ({ $var: name });
  const g = (key: JSONType, from: JSONType): JSONType => ({ $get: key, $from: from });

  const Color: Schema = { $ref: "#/$defs/Color" };
  const types: Defs = { Color: { enum: ["w", "b"] } };

  // A discriminated union: two object arms distinguished by a `tag` const.
  const Circle: Schema = {
    type: "object",
    properties: { tag: { const: "circle" }, r: I },
    required: ["tag", "r"],
    additionalProperties: false,
  };
  const Square: Schema = {
    type: "object",
    properties: { tag: { const: "square" }, side: I },
    required: ["tag", "side"],
    additionalProperties: false,
  };
  const shapeTypes: Defs = { Shape: { anyOf: [Circle, Square] } };
  const Shape: Schema = { $ref: "#/$defs/Shape" };

  test("enum match missing an arm warns (no $else, unhandled 'b')", () => {
    // (color: Color) => match color { "w" -> 1 }   // no "b", no $else
    const mod = {
      $types: types,
      f: body(["color"], { params: [Color], returns: I }, {
        $match: v("color"),
        $cases: [["w", 1]],
      } as JSONType),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(/unhandled case\(s\) "b"/.test(diags[0]!.message)).toBe(true);
  });

  test("a full enum match is clean even without an $else", () => {
    // (color: Color) => match color { "w" -> 1, "b" -> 2 }   // covers all
    const mod = {
      $types: types,
      f: body(["color"], { params: [Color], returns: I }, {
        $match: v("color"),
        $cases: [
          ["w", 1],
          ["b", 2],
        ],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("a present $else suppresses the exhaustiveness warning", () => {
    // (color: Color) => match color { "w" -> 1 } else 2
    const mod = {
      $types: types,
      f: body(["color"], { params: [Color], returns: I }, {
        $match: v("color"),
        $cases: [["w", 1]],
        $else: 2,
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("discriminated-union match missing an arm warns (unhandled 'square')", () => {
    // (s: Shape) => match s.tag { "circle" -> 1 }   // missing "square", no $else
    const mod = {
      $types: shapeTypes,
      f: body(["s"], { params: [Shape], returns: I }, {
        $match: g("tag", v("s")),
        $cases: [["circle", 1]],
      } as JSONType),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(/unhandled case\(s\) "square"/.test(diags[0]!.message)).toBe(true);
  });

  test("a full discriminated-union match is clean without an $else", () => {
    // (s: Shape) => match s.tag { "circle" -> 1, "square" -> 2 }
    const mod = {
      $types: shapeTypes,
      f: body(["s"], { params: [Shape], returns: I }, {
        $match: g("tag", v("s")),
        $cases: [
          ["circle", 1],
          ["square", 2],
        ],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("a dead/impossible case warns (literal not in the enum)", () => {
    // (color: Color) => match color { "w" -> 1, "x" -> 2 } else 3
    // "x" is not a Color, so that case can never match.
    const mod = {
      $types: types,
      f: body(["color"], { params: [Color], returns: I }, {
        $match: v("color"),
        $cases: [
          ["w", 1],
          ["x", 2],
        ],
        $else: 3,
      } as JSONType),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.path).toEqual(["f", "$return", "$cases[1][0]"]);
    expect(/Unreachable \$match case/.test(diags[0]!.message)).toBe(true);
  });

  test("a match over an infinite subject is not linted (undecidable universe)", () => {
    // (s: string) => match s { "hi" -> 1 }   // string is not finite → no lint
    const mod = {
      f: body(["s"], { params: [S], returns: I }, {
        $match: v("s"),
        $cases: [["hi", 1]],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });
});
