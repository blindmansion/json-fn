import { expect, test } from "bun:test";
import { runAllParseCases } from "./run-parse-cases";
import { join } from "path";
import { parseExpression as parse, parseModule } from "../src/shorthand";
import type { JSONType } from "../src/types";

runAllParseCases(join(import.meta.dir, "../../spec/cases/parse"));

test("module source is implicit and rejects an outer object wrapper", () => {
  expect(parseModule("main: () => 42")).toEqual({
    main: { $return: 42 },
  });
  expect(() => parseModule("{ main: () => 42 }")).toThrow(
    "expected data-object key, found 'lbrace'",
  );
});

test("empty where blocks are rejected", () => {
  expect(() => parse("value where {}")).toThrow(
    "empty 'where' block: at least one binding is required",
  );
});

test("where lowering preserves order without binding IIFEs or function locals", () => {
  const parsed = parse("(n) => total where { first: 1, total: sq(n) where { sq: (x) => x * x } }");
  expect(
    Object.keys((parsed as { $return: { $let: Record<string, JSONType> } }).$return.$let),
  ).toEqual(["first", "total"]);
  expectNoHistoricalBindingShape(parsed);
});

function expectNoHistoricalBindingShape(node: JSONType): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach(expectNoHistoricalBindingShape);
    return;
  }
  if ("$raw" in node) return;
  if ("$return" in node) {
    expect(Object.keys(node).every((key) => ["$sig", "$params", "$return"].includes(key))).toBe(
      true,
    );
  }
  if ("$call" in node && Array.isArray(node.$args) && node.$args.length === 0) {
    expect(
      typeof node.$call === "object" &&
        node.$call !== null &&
        !Array.isArray(node.$call) &&
        "$return" in node.$call,
    ).toBe(false);
  }
  Object.values(node).forEach(expectNoHistoricalBindingShape);
}
