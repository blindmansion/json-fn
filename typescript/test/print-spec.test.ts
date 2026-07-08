import { describe, test, expect } from "bun:test";
import { parse, print } from "../src/shorthand";
import type { JSONType } from "../src/types";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// The core guarantee of the printer is "bijective by normal form": for any
// canonical JSON, lowering the printed shorthand must reproduce that JSON
// exactly. Every `expected` value in the parse-case fixtures is canonical JSON,
// so it doubles as a printer round-trip corpus.

interface ParseCase {
  description: string;
  source: string;
  expected?: JSONType;
  error?: JSONType;
}

interface ParseSuite {
  description: string;
  cases: ParseCase[];
}

const CASES_DIR = join(import.meta.dir, "../../spec/parse-cases");

function roundTrips(json: JSONType): void {
  expect(parse(print(json))).toEqual(json);
}

describe("printer round-trips canonical JSON (parse ∘ print = id)", () => {
  const files = readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const suite: ParseSuite = JSON.parse(readFileSync(join(CASES_DIR, file), "utf-8"));
    describe(suite.description, () => {
      for (const tc of suite.cases) {
        // Skip cases that assert a parse *failure* — there is no canonical JSON.
        if (tc.error !== undefined) continue;
        test(tc.description, () => roundTrips(tc.expected ?? null));
      }
    });
  }
});

describe("printer output shape", () => {
  test("arithmetic prints as operators with correct precedence", () => {
    expect(print({ $fn: ["add", { $fn: ["mul", { $var: "row" }, 8] }, { $var: "col" }] })).toBe(
      "row * 8 + col",
    );
  });

  test("right operand of a left-assoc op is parenthesized", () => {
    expect(
      print({ $fn: ["sub", { $var: "a" }, { $fn: ["sub", { $var: "b" }, { $var: "c" }] }] }),
    ).toBe("a - (b - c)");
  });

  test("mixed string/expr strcat prints as a template", () => {
    expect(print({ $fn: ["strcat", "Illegal move: ", { $var: "moveDesc" }] })).toBe(
      "`Illegal move: ${moveDesc}`",
    );
  });

  test("pure-expression strcat prints as ++", () => {
    expect(print({ $fn: ["strcat", { $var: "a" }, { $var: "b" }, { $var: "c" }] })).toBe(
      "a ++ b ++ c",
    );
  });

  test("folded property path unfolds to dot/bracket access", () => {
    expect(print({ $var: "a", $get: ["b", 0, "c"] })).toBe("a.b[0].c");
  });

  test("function reference and evaluated callee", () => {
    expect(print({ $fn: ["map", { $fn: "double" }, { $var: "nums" }] })).toBe("map(&double, nums)");
    expect(print({ $fn: [{ $var: "fnName" }, 3, 4] })).toBe("(fnName)(3, 4)");
  });

  test("$-keyed object falls back to raw", () => {
    expect(print({ $raw: { $fn: ["not", "x"] } })).toBe('raw {"$fn":["not","x"]}');
  });

  test("object-pattern param prints as { f1, f2 } with spaces", () => {
    expect(
      print({
        $params: [{ $fields: ["from", "to"] }],
        $return: { $fn: ["sub", { $var: "to" }, { $var: "from" }] },
      }),
    ).toBe("({ from, to }) => to - from");
  });

  test("single-field pattern prints with braces", () => {
    expect(print({ $params: [{ $fields: ["x"] }], $return: { $var: "x" } })).toBe("({ x }) => x");
  });

  test("positional param mixes with a pattern slot", () => {
    expect(
      print({
        $params: ["label", { $fields: ["x", "y"] }],
        $return: { $fn: ["add", { $var: "x" }, { $var: "y" }] },
      }),
    ).toBe("(label, { x, y }) => x + y");
  });

  test("pattern slot followed by a rest parameter", () => {
    expect(print({ $params: [{ $fields: ["x"] }, "...rest"], $return: { $var: "rest" } })).toBe(
      "({ x }, ...rest) => rest",
    );
  });

  test("multiple pattern slots", () => {
    expect(
      print({
        $params: [{ $fields: ["a"] }, { $fields: ["b"] }],
        $return: { $fn: ["add", { $var: "a" }, { $var: "b" }] },
      }),
    ).toBe("({ a }, { b }) => a + b");
  });

  // A function body with locals prints its `$return` followed by `where { ... }`.
  // If the return is an `if` (or a nested lambda), the trailing `where` would
  // re-parse as attaching to the return's open tail instead of the body, so the
  // return must be parenthesized.
  test("if-return with where locals is parenthesized so where binds to the body", () => {
    const node: JSONType = {
      $params: ["s"],
      len: { $fn: ["length", { $var: "s" }] },
      $return: {
        $if: { $eq: [{ $var: "len" }, 2] },
        $then: { $var: "len" },
        $else: null,
      },
    };
    expect(print(node)).toBe(
      "(s) => (if len == 2 then len else null) where {\n  len: length(s)\n}",
    );
    expect(parse(print(node))).toEqual(node);
  });

  test("nested-lambda return with where locals is parenthesized", () => {
    const node: JSONType = {
      $params: ["p"],
      k: 1,
      $return: { $params: ["y"], $return: { $fn: ["add", { $var: "y" }, { $var: "k" }] } },
    };
    expect(parse(print(node))).toEqual(node);
    expect(print(node).startsWith("(p) => ((y) =>")).toBe(true);
  });

  test("data-object entry whose value is { $var: key } prints as a pun", () => {
    expect(print({ year: { $var: "year" } })).toBe("{ year }");
    expect(print({ year: { $var: "year" }, month: { $var: "month" }, day: { $var: "day" } })).toBe(
      "{\n  year,\n  month,\n  day\n}",
    );
  });

  test("punning only applies when the key matches the variable name", () => {
    expect(print({ month: { $var: "m" } })).toBe("{ month: m }");
  });

  test("a $var with a $get path is not a pun", () => {
    expect(print({ start: { $var: "start", $get: "year" } })).toBe("{ start: start.year }");
  });

  test("cond return with where locals needs no parens (brace-terminated)", () => {
    const node: JSONType = {
      $params: ["n"],
      big: { $fn: ["gt", { $var: "n" }, 10] },
      $return: {
        $cond: [[{ $var: "big" }, "yes"]],
        $else: "no",
      },
    };
    const out = print(node);
    expect(out.startsWith("(n) => cond {")).toBe(true);
    expect(parse(out)).toEqual(node);
  });
});
