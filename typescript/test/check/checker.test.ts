// TypeScript-local checker unit tests. The portable, observable checker
// behavior that used to live here (literal/data synthesis, assertions and
// ascription, visible `any` degradation, module checking and recovery,
// bidirectional literals/branches/lambdas, inline calls, recursive type
// contractivity, dangling refs, typed-function requirements, and declared
// return enforcement) has moved to the shared conformance corpus under
// `spec/cases/check/` (see `test/check-spec.test.ts`). What remains asserts
// internal behavior through hand-built `CheckContext`s and direct `synth`
// calls, plus schema-helper interplay that fixtures cannot express.

import { describe, expect, test } from "bun:test";
import type { JSONType } from "../../src/types";
import type { Schema } from "../../src/schema/schema.ts";
import { isSubschema } from "../../src/check/subsumption";
import { checkExpr } from "../../src/check/module";
import { synth } from "../../src/check/checker";
import type { CheckContext } from "../../src/check/context";

describe("synth: literals & schema-helper interplay", () => {
  test("a synthesized literal is a subtype of its declared refinement", () => {
    expect(isSubschema(checkExpr(5).type, { type: "integer", minimum: 0 })).toBe(true);
    expect(isSubschema(checkExpr(-5).type, { type: "integer", minimum: 0 })).toBe(false);
  });
});

describe("synth: checked ascription under a hand-built context", () => {
  test("does not narrow later uses of the source variable", () => {
    const source: Schema = {
      anyOf: [{ type: "integer" }, { type: "string" }],
    };
    const ctx: CheckContext = {
      defs: {},
      env: { lookupType: (name) => (name === "value" ? source : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(
      synth([{ $as: { $var: "value" }, $type: { type: "integer" } }, { $var: "value" }], ctx),
    ).toEqual({
      type: "array",
      prefixItems: [{ type: "integer" }, source],
      items: false,
      minItems: 2,
    });
    expect(ctx.diagnostics).toEqual([]);
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

describe("synth: computed index / key projection", () => {
  const I: Schema = { type: "integer" };
  const S: Schema = { type: "string" };
  const N: Schema = { type: "number" };
  const arr: Schema = { type: "array", items: I };
  const map: Schema = { type: "object", additionalProperties: I };
  const ctxWith = (env: Record<string, Schema>): CheckContext => ({
    defs: {},
    env: { lookupType: (n) => env[n] },
    diagnostics: [],
    path: [],
  });
  const get = (from: string, key: JSONType): JSONType => ({ $get: key, $from: { $var: from } });

  test("an integer-typed index projects an array's element type", () => {
    const ctx = ctxWith({ xs: arr, i: I });
    expect(synth(get("xs", { $var: "i" }), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a string-typed key projects a map's value type", () => {
    const ctx = ctxWith({ m: map, k: S });
    expect(synth(get("m", { $var: "k" }), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a computed index over a union of arrays joins their elements", () => {
    const ctx = ctxWith({
      xs: {
        anyOf: [
          { type: "array", items: I },
          { type: "array", items: S },
        ],
      },
      i: I,
    });
    expect(synth(get("xs", { $var: "i" }), ctx)).toEqual({ anyOf: [I, S] });
  });

  test("a computed index over a tuple joins every slot with null (out-of-bounds)", () => {
    const tuple: Schema = { type: "array", prefixItems: [I, S], items: false };
    const ctx = ctxWith({ t: tuple, i: I });
    expect(synth(get("t", { $var: "i" }), ctx)).toEqual({ anyOf: [I, S, { type: "null" }] });
  });

  test("a computed string key over a closed object joins its properties with null", () => {
    const obj: Schema = {
      type: "object",
      properties: { a: I, b: S },
      required: ["a", "b"],
      additionalProperties: false,
    };
    const ctx = ctxWith({ o: obj, k: S });
    expect(synth(get("o", { $var: "k" }), ctx)).toEqual({ anyOf: [I, S, { type: "null" }] });
  });

  test("a string index into an array is a hard error", () => {
    const ctx = ctxWith({ xs: arr, k: S });
    synth(get("xs", { $var: "k" }), ctx);
    expect(ctx.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("a number (integer-overlapping) index is a hard error (§4.5)", () => {
    const ctx = ctxWith({ xs: arr, i: N });
    const t = synth(get("xs", { $var: "i" }), ctx);
    expect(t).toEqual(I); // still projects the element
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
  });

  test("a fractional literal index is a hard error", () => {
    const ctx = ctxWith({ xs: arr });
    synth(get("xs", 2.5), ctx);
    expect(ctx.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("an any-typed key is permissive and still projects the container", () => {
    const ctx = ctxWith({ xs: arr, k: true });
    expect(synth(get("xs", { $var: "k" }), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });
});

describe("synth: missing closed-object field → hard error", () => {
  const I: Schema = { type: "integer" };
  const S: Schema = { type: "string" };
  const closed = (props: Record<string, Schema>, required: string[]): Schema => ({
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  });
  const ctxWith = (
    env: Record<string, Schema>,
    defs: Record<string, Schema> = {},
  ): CheckContext => ({
    defs,
    env: { lookupType: (n) => env[n] },
    diagnostics: [],
    path: [],
  });
  const get = (from: string, key: JSONType): JSONType => ({ $get: key, $from: { $var: from } });

  test("a literal string key absent from a closed object is a hard error", () => {
    const ctx = ctxWith({ o: closed({ name: S }, ["name"]) });
    synth(get("o", "nmae"), ctx);
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
    expect(ctx.diagnostics[0]!.message).toContain("nmae");
    expect(ctx.diagnostics[0]!.path).toEqual(["$get"]);
  });

  test("a present required key is fine", () => {
    const ctx = ctxWith({ o: closed({ name: S }, ["name"]) });
    expect(synth(get("o", "name"), ctx)).toEqual(S);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a declared-but-optional key is fine (projects T | null)", () => {
    const ctx = ctxWith({ o: closed({ name: S, score: I }, ["name"]) });
    expect(synth(get("o", "score"), ctx)).toEqual({ anyOf: [I, { type: "null" }] });
    expect(ctx.diagnostics).toEqual([]);
  });

  test("an open object stays permissive (no error, degrades to any)", () => {
    const open: Schema = { type: "object", properties: { name: S }, required: ["name"] };
    const ctx = ctxWith({ o: open });
    expect(synth(get("o", "whatever"), ctx)).toBe(true);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a map object stays permissive (no error, projects the value type)", () => {
    const map: Schema = { type: "object", additionalProperties: I };
    const ctx = ctxWith({ o: map });
    expect(synth(get("o", "any-key"), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a union where one arm supplies the key is fine (honest T | null)", () => {
    const u: Schema = {
      anyOf: [closed({ name: S, n: I }, ["name", "n"]), closed({ name: S }, ["name"])],
    };
    const ctx = ctxWith({ o: u });
    expect(synth(get("o", "n"), ctx)).toEqual({ anyOf: [I, { type: "null" }] });
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a union where every arm is closed-missing is a hard error", () => {
    const u: Schema = { anyOf: [closed({ a: I }, ["a"]), closed({ b: S }, ["b"])] };
    const ctx = ctxWith({ o: u });
    synth(get("o", "c"), ctx);
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
  });

  test("the error resolves through a $ref alias", () => {
    const ctx = ctxWith({ o: { $ref: "#/$defs/Rec" } }, { Rec: closed({ name: S }, ["name"]) });
    synth(get("o", "nmae"), ctx);
    expect(ctx.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("a nested path errors at the first closed segment that lacks its key", () => {
    const inner = closed({ x: I }, ["x"]);
    const outer = closed({ a: inner }, ["a"]);
    const ctx = ctxWith({ o: outer });
    // `o.a.y`: `a` exists, but `y` is missing on the (closed) inner object.
    synth({ $get: ["a", "y"], $from: { $var: "o" } }, ctx);
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
    expect(ctx.diagnostics[0]!.message).toContain("y");
  });

  test("an any / unknown target stays permissive", () => {
    const ctx = ctxWith({});
    expect(synth(get("o", "whatever"), ctx)).toBe(true);
    expect(ctx.diagnostics).toEqual([
      {
        path: ["$from"],
        message: 'expression degraded to `any` because variable "o" is unresolved.',
        severity: "info",
      },
    ]);
  });
});

describe("synth: control-flow unions", () => {
  test("$if widens literal branch results before joining them", () => {
    const ctx: CheckContext = {
      defs: {},
      env: { lookupType: () => undefined },
      diagnostics: [],
      path: [],
    };
    const t = synth({ $if: true, $then: 1, $else: "x" }, ctx);
    expect(t).toEqual({ anyOf: [{ type: "integer" }, { type: "string" }] });
    expect(synth({ $if: true, $then: 10, $else: 20 }, ctx)).toEqual({ type: "integer" });
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
      type: "string",
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
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  test("$cond: an arm's negated condition narrows the else arm", () => {
    // `cond { isNull(x): "d", else: x }` with `x: string | null`: the else arm
    // inherits the negation of the isNull guard, so `x` is plain string there
    // and the whole cond joins to string (docs/language/json/narrowing.md, control-flow
    // wiring for $cond).
    const nctx: CheckContext = {
      defs: {},
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(
      synth(
        {
          $cond: [[{ $call: "isNull", $args: [{ $var: "x" }] }, "d"]],
          $else: { $var: "x" },
        },
        nctx,
      ),
    ).toEqual({ type: "string" });
  });

  test("$cond: dominating guards accumulate into later arms", () => {
    // `cond { isNull(x): "d", p: x, else: "z" }` with `x: string | null`: the
    // second arm is reached only when the first condition was false, so `x`
    // is already narrowed to string before `p` is even consulted.
    const nctx: CheckContext = {
      defs: {},
      env: {
        lookupType: (n) => {
          if (n === "x") return { type: ["string", "null"] };
          if (n === "p") return { type: "boolean" };
          return undefined;
        },
      },
      diagnostics: [],
      path: [],
    };
    expect(
      synth(
        {
          $cond: [
            [{ $call: "isNull", $args: [{ $var: "x" }] }, "d"],
            [{ $var: "p" }, { $var: "x" }],
          ],
          $else: "z",
        },
        nctx,
      ),
    ).toEqual({ type: "string" });
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
    // The null-coalescing idiom: `(x: string | null) || "def"` is `string`;
    // the primitive arm already contains the literal fallback.
    const nctx: CheckContext = {
      ...ctx,
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
    };
    expect(synth({ $or: [{ $var: "x" }, "def"] }, nctx)).toEqual({ type: "string" });
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
