import { describe, expect, test } from "bun:test";
import type { JSONType } from "../../src/types";
import type { Schema, Defs } from "../../src/schema/schema.ts";
import type { CheckContext } from "../../src/check/context";
import { factsFromCondition, matchCaseFact, matchElseFact } from "../../src/check/narrowing";

// ---------------------------------------------------------------------------
// Frozen-narrowing table tests (docs/language/json/narrowing.md).
//
// These pin the exact fact each recognized condition form produces on both the
// then/matching sense and the else sense, plus the composition rules and the
// "no fact ⇒ never a silent pass" boundary. They are the regression anchor for
// the frozen set: a change to what narrows (or how) must move a row here.
//
// Facts are asserted directly off `factsFromCondition` / `matchCaseFact` /
// `matchElseFact` against a hand-built context, rather than through observable
// checker output, so each row states its subject's declared type and the fact
// map verbatim.
// ---------------------------------------------------------------------------

// Node builders (canonical JSON AST).
const v = (name: string): JSONType => ({ $var: name });
const call = (name: string, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
const get = (from: JSONType, field: string): JSONType => ({ $get: field, $from: from });

// A minimal check context: a flat term scope plus optional named-guard locals.
function ctxOf(
  env: Record<string, Schema>,
  opts: { defs?: Defs; guards?: Record<string, JSONType> } = {},
): CheckContext {
  return {
    defs: opts.defs ?? {},
    env: { lookupType: (name: string) => env[name] },
    diagnostics: [],
    path: [],
    guards: opts.guards,
  };
}

// Common schemas.
const strOrNull: Schema = { anyOf: [{ type: "string" }, { type: "null" }] };
const numOrNull: Schema = { anyOf: [{ type: "number" }, { type: "null" }] };
const intOrNull: Schema = { anyOf: [{ type: "integer" }, { type: "null" }] };
const strOrInt: Schema = { anyOf: [{ type: "string" }, { type: "integer" }] };
const numOrStr: Schema = { anyOf: [{ type: "number" }, { type: "string" }] };
const Color: Schema = { enum: ["w", "b"] };

// A tagged union: { tag: "a", r: integer } | { tag: "b", side: string }.
const armA: Schema = {
  type: "object",
  properties: { tag: { const: "a" }, r: { type: "integer" } },
  required: ["tag", "r"],
  additionalProperties: false,
};
const armB: Schema = {
  type: "object",
  properties: { tag: { const: "b" }, side: { type: "string" } },
  required: ["tag", "side"],
  additionalProperties: false,
};
const Tagged: Schema = { anyOf: [armA, armB] };

// The same union with singleton-`enum` discriminants: hand-written JSON Schema
// often spells `const x` as `enum [x]`; narrowing treats the two as identical.
const armAEnum: Schema = {
  type: "object",
  properties: { tag: { enum: ["a"] }, r: { type: "integer" } },
  required: ["tag", "r"],
  additionalProperties: false,
};
const armBEnum: Schema = {
  type: "object",
  properties: { tag: { enum: ["b"] }, side: { type: "string" } },
  required: ["tag", "side"],
  additionalProperties: false,
};
const TaggedEnum: Schema = { anyOf: [armAEnum, armBEnum] };

// A boolean-discriminated union: { ok: true, output: string } | { ok: false, error: string }.
const okArm: Schema = {
  type: "object",
  properties: { ok: { const: true }, output: { type: "string" } },
  required: ["ok", "output"],
  additionalProperties: false,
};
const errArm: Schema = {
  type: "object",
  properties: { ok: { const: false }, error: { type: "string" } },
  required: ["ok", "error"],
  additionalProperties: false,
};
const Result: Schema = { anyOf: [okArm, errArm] };

type Row = {
  name: string;
  env: Record<string, Schema>;
  cond: JSONType;
  sense: boolean;
  expected: Record<string, Schema>;
  guards?: Record<string, JSONType>;
  defs?: Defs;
};

function runTable(rows: Row[]): void {
  for (const row of rows) {
    test(row.name, () => {
      const ctx = ctxOf(row.env, { defs: row.defs, guards: row.guards });
      expect(factsFromCondition(row.cond, row.sense, ctx)).toEqual(row.expected);
    });
  }
}

describe("narrowing — truthiness (form 1)", () => {
  runTable([
    {
      name: "T | null: then keeps the non-null arm",
      env: { x: strOrNull },
      cond: v("x"),
      sense: true,
      expected: { x: { type: "string" } },
    },
    {
      name: "T | null: else keeps null plus the falsy slice of T",
      env: { x: strOrNull },
      cond: v("x"),
      sense: false,
      expected: { x: { anyOf: [{ const: "" }, { type: "null" }] } },
    },
    {
      name: "number | null: else drops down to the falsy 0 and null",
      env: { x: numOrNull },
      cond: v("x"),
      sense: false,
      expected: { x: { anyOf: [{ const: 0 }, { type: "null" }] } },
    },
    {
      name: "boolean: then/else pin to true/false",
      env: { x: { type: "boolean" } },
      cond: v("x"),
      sense: true,
      expected: { x: { const: true } },
    },
    {
      name: "boolean: else pins to false",
      env: { x: { type: "boolean" } },
      cond: v("x"),
      sense: false,
      expected: { x: { const: false } },
    },
    {
      name: "a field-path condition narrows the path itself",
      env: { u: { type: "object", properties: { active: strOrNull }, required: ["active"] } },
      cond: get(v("u"), "active"),
      sense: true,
      expected: { "u.active": { type: "string" } },
    },
    {
      name: "a boolean-discriminant path then keeps the truthy arm of the base",
      env: { r: Result },
      cond: get(v("r"), "ok"),
      sense: true,
      expected: { "r.ok": { const: true }, r: okArm },
    },
    {
      name: "a boolean-discriminant path else keeps the falsy arm of the base",
      env: { r: Result },
      cond: get(v("r"), "ok"),
      sense: false,
      expected: { "r.ok": { const: false }, r: errArm },
    },
    {
      name: "always-truthy discriminants leave both branches' base facts sound",
      env: { s: Tagged },
      cond: get(v("s"), "tag"),
      sense: false,
      // Every arm's tag is a nonempty-string const, so no arm admits a falsy
      // discriminant: the else branch is dead for the base.
      expected: { "s.tag": false, s: false },
    },
  ]);
});

describe("narrowing — type predicates (form 2)", () => {
  runTable([
    {
      name: "isNull then ⇒ null",
      env: { x: strOrNull },
      cond: call("isNull", v("x")),
      sense: true,
      expected: { x: { type: "null" } },
    },
    {
      name: "isNull else ⇒ non-null arm",
      env: { x: strOrNull },
      cond: call("isNull", v("x")),
      sense: false,
      expected: { x: { type: "string" } },
    },
    {
      name: "isString then keeps the string arm",
      env: { x: strOrInt },
      cond: call("isString", v("x")),
      sense: true,
      expected: { x: { type: "string" } },
    },
    {
      name: "isString else drops the string arm",
      env: { x: strOrInt },
      cond: call("isString", v("x")),
      sense: false,
      expected: { x: { type: "integer" } },
    },
    {
      name: "isNumber keeps an integer arm (number/integer overlap)",
      env: { x: strOrInt },
      cond: call("isNumber", v("x")),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "isString intersects any with string",
      env: { x: true },
      cond: call("isString", v("x")),
      sense: true,
      expected: { x: { type: "string" } },
    },
    {
      name: "isInteger turns number into integer on the true branch",
      env: { x: { type: "number" } },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "isInteger conservatively retains number on the false branch",
      env: { x: { type: "number" } },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: { type: "number" } },
    },
    {
      name: "isInteger intersects integer | string to integer",
      env: { x: strOrInt },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "isInteger subtracts integer from integer | string",
      env: { x: strOrInt },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: { type: "string" } },
    },
    {
      name: "isInteger intersects number | string to integer",
      env: { x: numOrStr },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "isInteger cannot exactly subtract integer from number | string",
      env: { x: numOrStr },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: numOrStr },
    },
    {
      name: "isInteger filters literal union arms exactly",
      env: { x: { anyOf: [{ const: 1 }, { const: 1.5 }, { type: "string" }] } },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { const: 1 } },
    },
    {
      name: "isInteger false filters integral literal union arms exactly",
      env: { x: { anyOf: [{ const: 1 }, { const: 1.5 }, { type: "string" }] } },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: { anyOf: [{ const: 1.5 }, { type: "string" }] } },
    },
    {
      name: "isInteger filters a mixed enum on the true branch",
      env: { x: { enum: [1, 1.5, "one"] } },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { const: 1 } },
    },
    {
      name: "isInteger filters a mixed enum on the false branch",
      env: { x: { enum: [1, 1.5, "one"] } },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: { enum: [1.5, "one"] } },
    },
    {
      name: "isInteger intersects any with integer",
      env: { x: true },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "isInteger leaves any unchanged on the false branch",
      env: { x: true },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: true },
    },
    {
      name: "isInteger preserves numeric refinements when changing the primitive",
      env: { x: { type: "number", minimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 } },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: {
        x: { type: "integer", minimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 },
      },
    },
    {
      name: "isInteger preserves and filters an enum attached to a refined number",
      env: { x: { type: "number", enum: [-1, 1, 1.5], minimum: 0 } },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: { x: { type: "integer", enum: [-1, 1], minimum: 0 } },
    },
    {
      name: "isInteger false preserves refinements while filtering a numeric enum",
      env: { x: { type: "number", enum: [-1, 1, 1.5], minimum: 0 } },
      cond: call("isInteger", v("x")),
      sense: false,
      expected: { x: { type: "number", enum: [1.5], minimum: 0 } },
    },
    {
      name: "isInteger on a field path narrows the path",
      env: {
        m: { type: "object", properties: { value: numOrStr }, required: ["value"] },
      },
      cond: call("isInteger", get(v("m"), "value")),
      sense: true,
      expected: { "m.value": { type: "integer" } },
    },
    {
      name: "isNull on a field-path subject narrows the path",
      env: { m: { type: "object", properties: { from: strOrNull }, required: ["from"] } },
      cond: call("isNull", get(v("m"), "from")),
      sense: false,
      expected: { "m.from": { type: "string" } },
    },
    {
      name: "a shadowed predicate name yields no fact",
      env: { x: strOrNull, isNull: { type: "boolean" } },
      cond: call("isNull", v("x")),
      sense: true,
      expected: {},
    },
    {
      name: "a shadowed isInteger yields no fact",
      env: { x: numOrStr, isInteger: { type: "boolean" } },
      cond: call("isInteger", v("x")),
      sense: true,
      expected: {},
    },
  ]);
});

describe("narrowing — equality: literal pin/exclude (form 3)", () => {
  runTable([
    {
      name: "eq(color, lit) then pins the literal",
      env: { color: Color },
      cond: call("eq", v("color"), "w"),
      sense: true,
      expected: { color: { const: "w" } },
    },
    {
      name: "eq(color, lit) else excludes the literal",
      env: { color: Color },
      cond: call("eq", v("color"), "w"),
      sense: false,
      expected: { color: { const: "b" } },
    },
    {
      name: "argument order is symmetric: eq(lit, color)",
      env: { color: Color },
      cond: call("eq", "w", v("color")),
      sense: true,
      expected: { color: { const: "w" } },
    },
    {
      name: "neq is eq with the sense flipped (then excludes)",
      env: { color: Color },
      cond: call("neq", v("color"), "w"),
      sense: true,
      expected: { color: { const: "b" } },
    },
    {
      name: "neq(x, null) then removes a primitive null union arm",
      env: { x: intOrNull },
      cond: call("neq", v("x"), null),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "eq(x, null) else removes a primitive null union arm",
      env: { x: intOrNull },
      cond: call("eq", v("x"), null),
      sense: false,
      expected: { x: { type: "integer" } },
    },
    {
      name: "null exclusion is symmetric in argument order",
      env: { x: intOrNull },
      cond: call("neq", null, v("x")),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "eq(x, null) then still pins null",
      env: { x: intOrNull },
      cond: call("eq", v("x"), null),
      sense: true,
      expected: { x: { const: null } },
    },
    {
      name: "null exclusion handles type-array unions",
      env: { x: { type: ["integer", "null"] } },
      cond: call("neq", v("x"), null),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "null exclusion resolves a named nullable type",
      env: { x: { $ref: "#/$defs/MaybeInt" } },
      defs: { MaybeInt: intOrNull },
      cond: call("neq", v("x"), null),
      sense: true,
      expected: { x: { type: "integer" } },
    },
    {
      name: "excluding a non-null literal from a broad primitive remains a no-op",
      env: { x: { type: "string" } },
      cond: call("neq", v("x"), "special"),
      sense: true,
      expected: { x: { type: "string" } },
    },
  ]);
});

describe("narrowing — equality: discriminant on a field path (form 4)", () => {
  runTable([
    {
      name: "s.tag == lit then keeps the matching arm (refines the base)",
      env: { s: Tagged },
      cond: call("eq", get(v("s"), "tag"), "a"),
      sense: true,
      expected: { s: armA },
    },
    {
      name: "s.tag == lit else drops the exact-const arm",
      env: { s: Tagged },
      cond: call("eq", get(v("s"), "tag"), "a"),
      sense: false,
      expected: { s: armB },
    },
    {
      name: "a singleton-enum discriminant counts as exact on the else branch",
      env: { s: TaggedEnum },
      cond: call("eq", get(v("s"), "tag"), "a"),
      sense: false,
      expected: { s: armBEnum },
    },
    {
      name: "a multi-value enum discriminant is not exact and survives else",
      env: {
        s: {
          anyOf: [
            {
              type: "object",
              properties: { tag: { enum: ["a", "c"] }, r: { type: "integer" } },
              required: ["tag", "r"],
              additionalProperties: false,
            },
            armBEnum,
          ],
        },
      },
      cond: call("eq", get(v("s"), "tag"), "a"),
      sense: false,
      expected: {
        s: {
          anyOf: [
            {
              type: "object",
              properties: { tag: { enum: ["a", "c"] }, r: { type: "integer" } },
              required: ["tag", "r"],
              additionalProperties: false,
            },
            armBEnum,
          ],
        },
      },
    },
  ]);
});

describe("narrowing — composition (form: not / $and / $or)", () => {
  runTable([
    {
      name: "not(isNull(x)) then ⇒ non-null (flipped sense)",
      env: { x: strOrNull },
      cond: call("not", call("isNull", v("x"))),
      sense: true,
      expected: { x: { type: "string" } },
    },
    {
      name: "not(isNull(x)) else ⇒ null",
      env: { x: strOrNull },
      cond: call("not", call("isNull", v("x"))),
      sense: false,
      expected: { x: { type: "null" } },
    },
    {
      name: "not(isInteger(x)) then uses conservative subtraction",
      env: { x: numOrStr },
      cond: call("not", call("isInteger", v("x"))),
      sense: true,
      expected: { x: numOrStr },
    },
    {
      name: "$and on the true sense conjoins each operand's fact",
      env: { a: strOrNull, b: strOrNull },
      cond: { $and: [call("not", call("isNull", v("a"))), call("not", call("isNull", v("b")))] },
      sense: true,
      expected: { a: { type: "string" }, b: { type: "string" } },
    },
    {
      name: "$and on the false sense yields no single-subject fact",
      env: { a: strOrNull, b: strOrNull },
      cond: { $and: [call("not", call("isNull", v("a"))), call("not", call("isNull", v("b")))] },
      sense: false,
      expected: {},
    },
    {
      name: "$or on the false sense conjoins the negated operands",
      env: { a: strOrNull, b: strOrNull },
      cond: { $or: [call("isNull", v("a")), call("isNull", v("b"))] },
      sense: false,
      expected: { a: { type: "string" }, b: { type: "string" } },
    },
    {
      name: "$or on the true sense yields no fact",
      env: { a: strOrNull, b: strOrNull },
      cond: { $or: [call("isNull", v("a")), call("isNull", v("b"))] },
      sense: true,
      expected: {},
    },
  ]);
});

describe("narrowing — named boolean guard bindings", () => {
  runTable([
    {
      name: "a boolean guard local adopts its binding's facts",
      env: { target: strOrNull },
      guards: { empty: call("isNull", v("target")) },
      cond: v("empty"),
      sense: false,
      expected: { target: { type: "string" } },
    },
    {
      name: "a named integer guard adopts its binding's facts",
      env: { target: numOrStr },
      guards: { integral: call("isInteger", v("target")) },
      cond: v("integral"),
      sense: true,
      expected: { target: { type: "integer" } },
    },
    {
      name: "guard aliases are followed (ok: not(empty), empty: isNull(target))",
      env: { target: strOrNull },
      guards: { empty: call("isNull", v("target")), ok: call("not", v("empty")) },
      cond: v("ok"),
      sense: true,
      expected: { target: { type: "string" } },
    },
    {
      name: "a guard local whose binding yields no fact falls back to truthiness",
      // Regression anchor for `if h then h else 0` with a named guard: the
      // binding (a plain call) isn't a recognized guard, so the bare local `h`
      // narrows by its own truthiness instead of returning {}.
      env: { h: intOrNull },
      guards: { h: call("len", v("xs")) },
      cond: v("h"),
      sense: true,
      expected: { h: { type: "integer" } },
    },
  ]);
});

describe("narrowing — no fact (never a silent pass)", () => {
  runTable([
    {
      name: "a dynamic (call-result) subject yields no fact",
      env: {},
      cond: call("eq", call("foo"), "x"),
      sense: true,
      expected: {},
    },
    {
      name: "an unrecognized guard form yields no fact",
      env: { x: intOrNull },
      cond: call("gt", v("x"), 3),
      sense: true,
      expected: {},
    },
    {
      name: "an unbound var yields no fact",
      env: {},
      cond: v("q"),
      sense: true,
      expected: {},
    },
  ]);
});

describe("narrowing — $match subject", () => {
  test("bare-var case pins the literal; else excludes it", () => {
    const ctx = ctxOf({ color: Color });
    expect(matchCaseFact(v("color"), "w", ctx)).toEqual({ color: { const: "w" } });
    expect(matchElseFact(v("color"), ["w"], ctx)).toEqual({ color: { const: "b" } });
  });

  test("a null case leaves the non-null arm for else", () => {
    const ctx = ctxOf({ x: intOrNull });
    expect(matchCaseFact(v("x"), null, ctx)).toEqual({ x: { const: null } });
    expect(matchElseFact(v("x"), [null], ctx)).toEqual({ x: { type: "integer" } });
  });

  test("discriminant-path case narrows the base to the matching arm; else drops it", () => {
    const ctx = ctxOf({ s: Tagged });
    expect(matchCaseFact(get(v("s"), "tag"), "a", ctx)).toEqual({ s: armA });
    expect(matchElseFact(get(v("s"), "tag"), ["a"], ctx)).toEqual({ s: armB });
  });

  test("a dynamic subject yields no fact", () => {
    const ctx = ctxOf({});
    expect(matchCaseFact(call("foo"), "a", ctx)).toEqual({});
    expect(matchElseFact(call("foo"), ["a"], ctx)).toEqual({});
  });
});
