import { describe, expect, test } from "bun:test";
import { checkExpr } from "../src/check/module";
import { valueSatisfies } from "../src/schema/values";
import { setOwnProperty, getOwnProperty } from "../src/own-properties";
import type { JSONType } from "../src/types";

// Guest-object invariant: every JSON key — including "__proto__" and names
// that collide with Object.prototype members — is an own, enumerable,
// writable data property, and no path may observe inherited members instead.
// The evaluator-facing coverage lives in spec/cases/eval/special-object-keys.json
// and spec/cases/parse/special-object-keys.json; this file covers the
// checker/validation surfaces and the shared helper itself.

const json = (text: string): JSONType => JSON.parse(text) as JSONType;

describe("own-property helpers", () => {
  test("setOwnProperty defines __proto__ as an own data property", () => {
    const target: Record<string, JSONType> = {};
    setOwnProperty(target, "__proto__", { p: 1 });
    expect(Object.hasOwn(target, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(Object.keys(target)).toEqual(["__proto__"]);
  });

  test("getOwnProperty does not observe inherited members", () => {
    expect(getOwnProperty({}, "constructor")).toBeUndefined();
    expect(getOwnProperty({}, "toString")).toBeUndefined();
    expect(getOwnProperty(json(`{"__proto__": 5}`) as Record<string, JSONType>, "__proto__")).toBe(
      5,
    );
  });
});

describe("checker: special object keys", () => {
  test("object literal with __proto__ synthesizes an own property schema", () => {
    const { type, diagnostics } = checkExpr(json(`{"__proto__": 1, "b": 2}`));
    expect(diagnostics).toEqual([]);
    const schema = type as { properties: Record<string, JSONType>; required: string[] };
    expect(Object.hasOwn(schema.properties, "__proto__")).toBe(true);
    expect(schema.required).toEqual(["__proto__", "b"]);
    expect(getOwnProperty(schema.properties, "__proto__")).toEqual({ const: 1 });
  });

  test("$raw payload with __proto__ is typed with an own property", () => {
    const { type } = checkExpr(json(`{"$raw": {"__proto__": {"p": 1}}}`));
    const schema = type as { properties: Record<string, JSONType> };
    expect(Object.hasOwn(schema.properties, "__proto__")).toBe(true);
  });

  test("calling an inherited Object.prototype name is an unknown function", () => {
    const { diagnostics } = checkExpr(json(`{"$call": "hasOwnProperty", "$args": ["x"]}`));
    expect(diagnostics.some((d) => d.message.includes('Unknown function "hasOwnProperty"'))).toBe(
      true,
    );
  });
});

describe("schema validation: special object keys", () => {
  const requiresProto = json(
    `{"type": "object", "properties": {"__proto__": {"type": "number"}}, "required": ["__proto__"], "additionalProperties": false}`,
  );
  const requiresConstructor = json(
    `{"type": "object", "properties": {"constructor": {"type": "number"}}, "required": ["constructor"]}`,
  );

  test("a required __proto__ key is validated against its own value", () => {
    expect(valueSatisfies(json(`{"__proto__": 3}`), requiresProto)).toBe(true);
    expect(valueSatisfies(json(`{"__proto__": "not a number"}`), requiresProto)).toBe(false);
  });

  test("a missing required key colliding with Object.prototype fails", () => {
    expect(valueSatisfies(json(`{}`), requiresProto)).toBe(false);
    expect(valueSatisfies(json(`{}`), requiresConstructor)).toBe(false);
    expect(valueSatisfies(json(`{"constructor": 1}`), requiresConstructor)).toBe(true);
  });
});
