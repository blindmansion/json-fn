import { describe, test, expect } from "bun:test";
import {
  parseExpression as parse,
  parseModule,
  printExpression as print,
  printModule,
} from "../src/shorthand";
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
  mode?: "expression" | "module";
  expected?: JSONType;
  error?: JSONType;
}

interface ParseSuite {
  description: string;
  mode?: "expression" | "module";
  cases: ParseCase[];
}

const CASES_DIR = join(import.meta.dir, "../../spec/parse-cases");
const EXAMPLES_DIR = join(import.meta.dir, "../../examples");

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
        test(tc.description, () => {
          if ((tc.mode ?? suite.mode) === "module") {
            const json = tc.expected ?? {};
            expect(parseModule(printModule(json))).toEqual(json);
          } else {
            roundTrips(tc.expected ?? null);
          }
        });
      }
    });
  }
});

describe("printer output shape", () => {
  test("prints typed modules as declarations and typed bindings", () => {
    const node = parseModule("type N = integer\nid: (x: N) -> N => x");
    expect(printModule(node)).toBe("type N = integer\nid: (x: N) -> N => x");
    expect(parseModule(printModule(node))).toEqual(node);
  });

  test("round-trips the type syntax showcase module", () => {
    const source = readFileSync(join(EXAMPLES_DIR, "types.jfn"), "utf-8");
    const node = parseModule(source);
    expect(parseModule(printModule(node))).toEqual(node);
  });

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

  test("prints non-null assertions and checked ascriptions canonically", () => {
    expect(print({ $nonnull: { $var: "value" } })).toBe("value!");
    expect(
      print({
        $as: {
          $call: "add",
          $args: [{ $var: "balance" }, { $var: "delta" }],
        },
        $type: { $ref: "#/$defs/Cents" },
      }),
    ).toBe("balance + delta checked as Cents");
  });

  test("parenthesizes assertion forms to preserve precedence and association", () => {
    const ascribed: JSONType = {
      $as: { $var: "value" },
      $type: { $ref: "#/$defs/Count" },
    };
    expect(print({ $call: "add", $args: [1, ascribed] })).toBe("1 + (value checked as Count)");
    expect(print({ $nonnull: ascribed })).toBe("(value checked as Count)!");
    expect(print({ $as: ascribed, $type: { type: "number" } })).toBe(
      "(value checked as Count) checked as number",
    );
  });

  test("parses assertion precedence and canonical forms", () => {
    expect(parse("value! checked as Count")).toEqual({
      $as: { $nonnull: { $var: "value" } },
      $type: { $ref: "#/$defs/Count" },
    });
    expect(parse("balance + (delta checked as Cents)")).toEqual({
      $call: "add",
      $args: [
        { $var: "balance" },
        {
          $as: { $var: "delta" },
          $type: { $ref: "#/$defs/Cents" },
        },
      ],
    });
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

  test("rejects array-valued function references at any expression depth", () => {
    expect(() => print({ $fn: ["add", 1, 2] })).toThrow(
      "Cannot print function reference at $: $fn cannot be an array; use $call/$args for calls.",
    );
    expect(() => print({ $call: "map", $args: [{ $fn: ["upper"] }, ["a", "b"]] })).toThrow(
      "function reference at $.$args[0]",
    );
  });

  test("retains dynamic function references and opaque raw arrays", () => {
    const dynamic: JSONType = {
      $fn: {
        $if: { $var: "enabled" },
        $then: { $var: "primary" },
        $else: { $var: "fallback" },
      },
    };
    expect(print(dynamic)).toBe("&(if enabled then primary else fallback)");
    expect(parse(print(dynamic))).toEqual(dynamic);
    expect(print({ $raw: { $fn: ["add", 1, 2] } })).toBe('raw {"$fn":["add",1,2]}');
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

  // A function-body `$let` naturally prints as the body-level `where`.
  test("if-return with a structural let binds to the body without parentheses", () => {
    const node: JSONType = {
      $params: ["s"],
      $return: {
        $let: { len: { $call: "length", $args: [{ $var: "s" }] } },
        $in: {
          $if: { $call: "eq", $args: [{ $var: "len" }, 2] },
          $then: { $var: "len" },
          $else: null,
        },
      },
    };
    expect(print(node)).toBe("(s) => if len == 2 then len else null where {\n  len: length(s)\n}");
    expect(parse(print(node))).toEqual(node);
  });

  test("nested-lambda result before a function-body where is parenthesized", () => {
    const node: JSONType = {
      $params: ["p"],
      $return: {
        $let: { k: 1 },
        $in: {
          $params: ["y"],
          $return: { $call: "add", $args: [{ $var: "y" }, { $var: "k" }] },
        },
      },
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

  test("cond result before a function-body where needs no parens", () => {
    const node: JSONType = {
      $params: ["n"],
      $return: {
        $let: { big: { $call: "gt", $args: [{ $var: "n" }, 10] } },
        $in: {
          $cond: [[{ $var: "big" }, "yes"]],
          $else: "no",
        },
      },
    };
    const out = print(node);
    expect(out.startsWith("(n) => cond {")).toBe(true);
    expect(parse(out)).toEqual(node);
  });

  test("prints canonical lets and preserves binding order", () => {
    const node: JSONType = {
      $let: {
        sum: { $call: "add", $args: [1, 2] },
        double: { $call: "mul", $args: [{ $var: "sum" }, 2] },
      },
      $in: { $var: "double" },
    };
    expect(print(node)).toBe("double where {\n  sum: 1 + 2,\n  double: sum * 2\n}");
    expect(parse(print(node))).toEqual(node);
  });

  test("does not fold noncanonical synthetic comparison names", () => {
    const node: JSONType = {
      $let: {
        __jfn_cmp_7: { $call: "value", $args: [] },
      },
      $in: {
        $and: [
          { $call: "lt", $args: [0, { $var: "__jfn_cmp_7" }] },
          { $call: "lt", $args: [{ $var: "__jfn_cmp_7" }, 10] },
        ],
      },
    };
    expect(print(node)).toContain("where");
    expect(parse(print(node))).toEqual(node);
  });

  test("parenthesizes nested lets without flattening them", () => {
    const node: JSONType = {
      $let: { outer: 2 },
      $in: { $let: { inner: 1 }, $in: { $var: "x" } },
    };
    expect(print(node)).toBe("(x where {\n  inner: 1\n}) where {\n  outer: 2\n}");
    expect(parse(print(node))).toEqual(node);
  });

  test("keeps a genuine zero-argument IIFE as a call", () => {
    const node: JSONType = { $call: { $return: 1 }, $args: [] };
    expect(print(node)).toBe("(() => 1)()");
    expect(parse(print(node))).toEqual(node);
  });

  test("rejects evaluator captures, including in do continuations", () => {
    expect(() => print({ $return: 1, $captures: { closed: { $return: 2 } } })).toThrow(
      "runtime closure state has no shorthand syntax",
    );
    expect(() =>
      print({
        $call: "bind",
        $args: [
          1,
          {
            $return: 2,
            $captures: { closed: { $return: 3 } },
          },
        ],
      }),
    ).toThrow("$captures");
  });

  test("keeps capture-shaped raw payloads opaque", () => {
    const node: JSONType = {
      $raw: { $return: 1, $captures: { closed: { $return: 2 } } },
    };
    expect(print(node)).toBe('raw {"$return":1,"$captures":{"closed":{"$return":2}}}');
  });

  test("rejects historical and unknown function-body keys", () => {
    expect(() => print({ local: 1, $return: { $var: "local" } })).toThrow(
      'unsupported key "local"',
    );
    expect(() => print({ $mystery: 1, $return: null })).toThrow('unsupported key "$mystery"');
  });

  test("rejects malformed and unspellable lets", () => {
    expect(() => print({ $in: 1 })).toThrow("expected exactly $let and $in");
    expect(() => print({ $let: {}, $in: 1 })).toThrow("at least one binding");
    expect(() => print({ $let: [], $in: 1 })).toThrow("$let must be an object");
    expect(() => print({ $let: { x: 1 }, $in: 1, extra: true })).toThrow(
      "expected exactly $let and $in",
    );
    expect(() => print({ $let: { "not-valid": 1 }, $in: 1 })).toThrow('"not-valid"');
  });
});
