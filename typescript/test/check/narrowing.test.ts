import { describe, expect, test } from "bun:test";
import type { JSONType } from "../../src/types";
import type { Schema, Defs } from "../../src/check/schema";
import type { CheckContext } from "../../src/check/context";
import { factsFromCondition, matchCaseFact, matchElseFact } from "../../src/check/narrowing";

// ---------------------------------------------------------------------------
// Frozen-narrowing table tests (docs/narrowing.md).
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

describe("narrowing — named boolean guards (where-locals)", () => {
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
      name: "guard aliases are followed (ok: not(empty), empty: isNull(target))",
      env: { target: strOrNull },
      guards: { empty: call("isNull", v("target")), ok: call("not", v("empty")) },
      cond: v("ok"),
      sense: true,
      expected: { target: { type: "string" } },
    },
    {
      name: "a guard local whose binding yields no fact falls back to truthiness",
      // Regression anchor for the `if h then h else 0` where-local fix: the
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
