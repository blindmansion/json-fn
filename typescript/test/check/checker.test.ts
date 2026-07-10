import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../../src/builtins";
import type { JSONType } from "../../src/types";
import type { Schema } from "../../src/check/schema";
import { isSubschema } from "../../src/check/subsumption";
import { checkExpr, checkModule } from "../../src/check/module";
import { synth } from "../../src/check/checker";
import type { CheckContext } from "../../src/check/context";

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

  test("$get on an optional field projects `T | null`", () => {
    const $types = {
      User: {
        type: "object",
        properties: { id: S, score: I },
        required: ["id"], // `score` optional
        additionalProperties: false,
      },
    };
    const userRef = { $ref: "#/$defs/User" };
    const scoreOf = (ret: Schema): Record<string, JSONType> => ({
      $types,
      f: body(["u"], { params: [userRef], returns: ret }, { $get: "score", $from: { $var: "u" } }),
    });

    // Optional access is `integer | null`, so it fits `integer | null` cleanly
    // but not a bare `integer` (absence must be handled).
    expect(checkModule(scoreOf({ type: ["integer", "null"] }))).toEqual([]);
    expect(checkModule(scoreOf(I)).length).toBeGreaterThan(0);

    // A required field keeps its bare type.
    const idOf = body(
      ["u"],
      { params: [userRef], returns: S },
      { $get: "id", $from: { $var: "u" } },
    );
    expect(checkModule({ $types, f: idOf })).toEqual([]);
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

describe("synth: field projection over a union", () => {
  // A tagged union whose arms share the `tag` discriminant; `n` lives on one arm.
  const F: Schema = {
    anyOf: [
      {
        type: "object",
        properties: { tag: { const: "a" }, n: { type: "integer" } },
        required: ["tag", "n"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { tag: { const: "b" } },
        required: ["tag"],
        additionalProperties: false,
      },
    ],
  };
  const ctxWith = (env: Record<string, Schema>): CheckContext => ({
    defs: {},
    env: { lookupType: (n) => env[n] },
    diagnostics: [],
    path: [],
  });

  test("a shared discriminant projects to the union of its per-arm literals", () => {
    const t = synth({ $get: "tag", $from: { $var: "x" } }, ctxWith({ x: F }));
    expect(t).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] });
  });

  test("a field on only some arms projects to the join, absent arms contributing null", () => {
    const t = synth({ $get: "n", $from: { $var: "x" } }, ctxWith({ x: F }));
    expect(t).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
  });

  test("projection resolves through a $ref union alias", () => {
    const ctx: CheckContext = {
      defs: { F },
      env: { lookupType: (n) => (n === "x" ? { $ref: "#/$defs/F" } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(synth({ $get: "tag", $from: { $var: "x" } }, ctx)).toEqual({
      anyOf: [{ const: "a" }, { const: "b" }],
    });
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

  test("$if narrows a bare-value condition by truthiness in each branch", () => {
    // `if x then x else "d"` where `x: string | null`: the then-branch sees the
    // truthy slice of `x` (null dropped), mirroring the `x || "d"` idiom.
    const nctx: CheckContext = {
      defs: {},
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(synth({ $if: { $var: "x" }, $then: { $var: "x" }, $else: "d" }, nctx)).toEqual({
      anyOf: [{ type: "string" }, { const: "d" }],
    });
  });

  test("$if surfaces the falsy slice on the else-branch", () => {
    // `if x then "d" else x`: the else-branch keeps only `x`'s falsy slice
    // (`"" | null`).
    const nctx: CheckContext = {
      defs: {},
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(synth({ $if: { $var: "x" }, $then: "d", $else: { $var: "x" } }, nctx)).toEqual({
      anyOf: [{ const: "d" }, { const: "" }, { type: "null" }],
    });
  });
});

describe("synth: short-circuit $and / $or are value-returning", () => {
  const ctx: CheckContext = {
    defs: {},
    env: { lookupType: () => undefined },
    diagnostics: [],
    path: [],
  };

  test("$and yields the last operand when earlier ones can't be falsy", () => {
    // `1 && 2` evaluates to `2`; the truthy `1` can never be the result.
    expect(synth({ $and: [1, 2] }, ctx)).toEqual({ const: 2 });
  });

  test("$or yields the last operand when earlier ones can't be truthy", () => {
    // `0 || 5` evaluates to `5`; the falsy `0` can never be the result.
    expect(synth({ $or: [0, 5] }, ctx)).toEqual({ const: 5 });
  });

  test("boolean operands split by truthiness (true && false : false)", () => {
    expect(synth({ $and: [true, false] }, ctx)).toEqual({ const: false });
  });

  test("$or over a nullable subject drops null from the non-final operand", () => {
    // The null-coalescing idiom: `(x: string | null) || "def"` is `string | "def"`.
    const nctx: CheckContext = {
      ...ctx,
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
    };
    expect(synth({ $or: [{ $var: "x" }, "def"] }, nctx)).toEqual({
      anyOf: [{ type: "string" }, { const: "def" }],
    });
  });

  test("$and over a nullable subject keeps only its falsy slice, plus the tail", () => {
    // `(x: string | null) && upper(x)` : the falsy slice of `x` is `"" | null`.
    const nctx: CheckContext = {
      ...ctx,
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
    };
    expect(synth({ $and: [{ $var: "x" }, "tail"] }, nctx)).toEqual({
      anyOf: [{ const: "" }, { type: "null" }, { const: "tail" }],
    });
  });

  test("empty $and is true, empty $or is false", () => {
    expect(synth({ $and: [] }, ctx)).toEqual({ const: true });
    expect(synth({ $or: [] }, ctx)).toEqual({ const: false });
  });
});

describe("declared return type is enforced outside the module path", () => {
  const BT = loadBuiltinTable();

  test("checkExpr: a standalone typed lambda checks its body vs the declared return", () => {
    // `(n: integer) -> string => n`: the body is integer, disjoint from string.
    const { diagnostics } = checkExpr(body(["n"], { params: [I], returns: S }, { $var: "n" }));
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]!.severity).toBe("error");
    expect(diagnostics[0]!.path).toEqual(["$return"]);
  });

  test("checkExpr: a well-typed standalone lambda is clean", () => {
    expect(checkExpr(body(["n"], { params: [I], returns: I }, { $var: "n" })).diagnostics).toEqual(
      [],
    );
  });

  test("inline typed lambda in a builtin call honors its own declared return", () => {
    // `map((n: integer) -> string => n, [1,2,3])`: the callback body violates
    // its self-declared `-> string`.
    const call = {
      $call: "map",
      $args: [body(["n"], { params: [I], returns: S }, { $var: "n" }), [1, 2, 3]],
    };
    expect(checkExpr(call, {}, BT).diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("inline typed lambda with a matching declared return is clean", () => {
    const call = {
      $call: "map",
      $args: [body(["n"], { params: [I], returns: I }, { $var: "n" }), [1, 2, 3]],
    };
    expect(checkExpr(call, {}, BT).diagnostics).toEqual([]);
  });
});
