import { describe, expect, test } from "bun:test";
import type { JSONType } from "../../src/types";
import { nodeKind } from "../../src/check/ast";

// ---------------------------------------------------------------------------
// Section E — nodeKind classifier
// ---------------------------------------------------------------------------

describe("nodeKind", () => {
  const cases: [string, JSONType, ReturnType<typeof nodeKind>][] = [
    ["scalar (number)", 42, "scalar"],
    ["scalar (null)", null, "scalar"],
    ["array literal", [1, 2], "array"],
    ["var", { $var: "x" }, "var"],
    ["call", { $call: "f", $args: [] }, "call"],
    ["fn reference", { $fn: "f" }, "ref"],
    ["function body", { $params: ["x"], $return: { $var: "x" } }, "body"],
    ["if", { $if: true, $then: 1, $else: 2 }, "if"],
    ["cond", { $cond: [[true, 1]], $else: 2 }, "cond"],
    ["match", { $match: 1, $cases: [[1, "a"]], $else: "b" }, "match"],
    ["and", { $and: [true, false] }, "and"],
    ["or", { $or: [true, false] }, "or"],
    ["get", { $get: "k", $from: { $var: "o" } }, "get"],
    ["raw", { $raw: { $var: "not-evaluated" } }, "raw"],
    ["object literal", { a: 1, b: 2 }, "object"],
  ];
  for (const [name, node, kind] of cases) {
    test(name, () => expect(nodeKind(node)).toBe(kind));
  }
});
