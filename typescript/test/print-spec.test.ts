import { describe, test, expect } from "bun:test";
import { parse, print } from "../src/shorthand";
import { printType } from "../src/shorthand/type-printer";
import type { JSONType } from "../src/types";
import { analyzeParameters } from "../src/params";
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
  const parsed = parse(print(json));
  expect(parsed).toEqual(json);
  expectParsedParameterLayouts(parsed);
}

function expectParsedParameterLayouts(node: JSONType): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const value of node) expectParsedParameterLayouts(value);
    return;
  }
  if ("$raw" in node) return;
  if ("$return" in node) {
    expect(analyzeParameters(node.$params).ok).toBe(true);
  }
  for (const value of Object.values(node)) expectParsedParameterLayouts(value);
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
  test("prints optional callable slots", () => {
    expect(
      printType({
        $fnType: {
          required: [{ type: "string" }],
          optional: [{ type: "integer" }],
          returns: { type: "boolean" },
        },
      }),
    ).toBe("(string, integer?) -> boolean");
  });

  test("erased task completion types print as Task<A>", () => {
    const node: JSONType = {
      $sig: {
        required: [],
        optional: [],
        returns: { $taskType: { anyOf: [{ $ref: "#/$defs/Reading" }, { type: "null" }] } },
      },
      $return: { $call: "pure", $args: [null] },
    };
    expect(print(node)).toBe("() -> Task<Reading | null> => pure(null)");
    expect(parse(print(node))).toEqual(node);
  });

  test("arithmetic prints as operators with correct precedence", () => {
    expect(
      print({
        $call: "add",
        $args: [{ $call: "mul", $args: [{ $var: "row" }, 8] }, { $var: "col" }],
      }),
    ).toBe("row * 8 + col");
  });

  test("right operand of a left-assoc op is parenthesized", () => {
    expect(
      print({
        $call: "sub",
        $args: [{ $var: "a" }, { $call: "sub", $args: [{ $var: "b" }, { $var: "c" }] }],
      }),
    ).toBe("a - (b - c)");
  });

  test("mixed string/expr strcat prints as a template", () => {
    expect(print({ $call: "strcat", $args: ["Illegal move: ", { $var: "moveDesc" }] })).toBe(
      "`Illegal move: ${moveDesc}`",
    );
  });

  test("pure-expression strcat prints as ++", () => {
    expect(print({ $call: "strcat", $args: [{ $var: "a" }, { $var: "b" }, { $var: "c" }] })).toBe(
      "a ++ b ++ c",
    );
  });

  test("folded property path unfolds to dot/bracket access", () => {
    expect(print({ $get: ["b", 0, "c"], $from: { $var: "a" } })).toBe("a.b[0].c");
  });

  test("function reference and evaluated callee", () => {
    expect(print({ $call: "map", $args: [{ $fn: "double" }, { $var: "nums" }] })).toBe(
      "map(&double, nums)",
    );
    expect(print({ $call: { $var: "fnName" }, $args: [3, 4] })).toBe("(fnName)(3, 4)");
  });

  test("$-keyed object falls back to raw", () => {
    expect(print({ $raw: { $fn: ["not", "x"] } })).toBe('raw {"$fn":["not","x"]}');
  });

  test("object-pattern param prints as { f1, f2 } with spaces", () => {
    expect(
      print({
        $params: [{ $fields: ["from", "to"] }],
        $return: { $call: "sub", $args: [{ $var: "to" }, { $var: "from" }] },
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
        $return: { $call: "add", $args: [{ $var: "x" }, { $var: "y" }] },
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
        $return: { $call: "add", $args: [{ $var: "a" }, { $var: "b" }] },
      }),
    ).toBe("({ a }, { b }) => a + b");
  });

  test("typed fixed and rest schemas align with normalized slots", () => {
    const node: JSONType = {
      $sig: {
        required: [{ type: "string" }, { type: "object" }],
        optional: [],
        rest: { type: "integer" },
        returns: { type: "array", items: { type: "integer" } },
      },
      $params: ["label", { $fields: ["x", "y"] }, "...rest"],
      $return: { $var: "rest" },
    };

    expect(print(node)).toBe(
      "(label: string, { x, y }: { ... }, ...rest: integer[]) -> integer[] => rest",
    );
    expect(parse(print(node))).toEqual(node);
  });

  test("prints optional and defaulted parameter descriptors", () => {
    const node: JSONType = {
      $params: [
        "required",
        { $param: "optional", $optional: true },
        { $param: "defaulted", $default: 1 },
      ],
      $return: null,
    };
    expect(print(node)).toBe("(required, optional?, defaulted = 1) => null");
    expect(parse(print(node))).toEqual(node);
  });

  test("prints typed optional and defaulted parameters", () => {
    const node: JSONType = {
      $sig: {
        required: [{ type: "string" }],
        optional: [{ type: "integer" }, { type: "boolean" }],
        returns: { type: "boolean" },
      },
      $params: [
        "name",
        { $param: "count", $optional: true },
        { $param: "enabled", $default: true },
      ],
      $return: { $var: "enabled" },
    };
    expect(print(node)).toBe(
      "(name: string, count?: integer, enabled: boolean = true) -> boolean => enabled",
    );
    expect(parse(print(node))).toEqual(node);
  });

  test("prints optional and defaulted object fields", () => {
    const node: JSONType = {
      $params: [
        {
          $fields: [
            "required",
            { $field: "label", $optional: true },
            { $field: "count", $default: 0 },
          ],
        },
      ],
      $return: { $var: "count" },
    };
    expect(print(node)).toBe("({ required, label?, count = 0 }) => count");
    expect(parse(print(node))).toEqual(node);
  });

  test("reports malformed descriptors with the shared canonical path", () => {
    expect(() =>
      print({
        $params: [{ $fields: [{ $field: "value", $optional: false }] }],
        $return: null,
      }),
    ).toThrow("$params[0].$fields[0].$optional: $optional must be true.");
  });

  // A function body with locals prints its `$return` followed by `where { ... }`.
  // If the return is an `if` (or a nested lambda), the trailing `where` would
  // re-parse as attaching to the return's open tail instead of the body, so the
  // return must be parenthesized.
  test("if-return with where locals is parenthesized so where binds to the body", () => {
    const node: JSONType = {
      $params: ["s"],
      len: { $call: "length", $args: [{ $var: "s" }] },
      $return: {
        $if: { $call: "eq", $args: [{ $var: "len" }, 2] },
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
      $return: { $params: ["y"], $return: { $call: "add", $args: [{ $var: "y" }, { $var: "k" }] } },
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

  test("a property access is not a pun", () => {
    expect(print({ start: { $get: "year", $from: { $var: "start" } } })).toBe(
      "{ start: start.year }",
    );
  });

  test("cond return with where locals needs no parens (brace-terminated)", () => {
    const node: JSONType = {
      $params: ["n"],
      big: { $call: "gt", $args: [{ $var: "n" }, 10] },
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
