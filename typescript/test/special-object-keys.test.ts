import { describe, expect, test } from "bun:test";
import { valueSatisfies } from "../src/schema/values";
import { setOwnProperty, getOwnProperty } from "../src/own-properties";
import type { JSONType } from "../src/types";

// Guest-object invariant: every JSON key — including "__proto__" and names
// that collide with Object.prototype members — is an own, enumerable,
// writable data property, and no path may observe inherited members instead.
// Portable evaluator, parser, and checker coverage lives under spec/cases/.
// This file covers host own-property/prototype behavior and schema satisfaction.

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
