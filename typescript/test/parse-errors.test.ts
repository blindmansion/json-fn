import { describe, expect, test } from "bun:test";
import { parse } from "../src/shorthand";
import { ParseError } from "../src/shorthand/error";

// Regression coverage for the typed-lambda header lookahead. A malformed return
// annotation used to be swallowed by `returnTypeEndsInFatArrow`'s try/catch: the
// `(` was then re-read as a parenthesized expression, so the error surfaced at
// the *parameter colon* (`x:`) instead of the offending return type. The header
// is now recognized structurally (a `=>` follows the annotation at the same
// bracket depth), so the real type-parse error lands at the annotation.
describe("typed-lambda return annotation errors", () => {
  const parseError = (src: string): ParseError => {
    try {
      parse(src);
    } catch (e) {
      if (e instanceof ParseError) return e;
      throw e;
    }
    throw new Error(`expected "${src}" to fail parsing`);
  };

  // Column 3 is the parameter colon in `(x: number) -> …`; the return type
  // starts at column 16 (just past the `-> `). The error must point at the
  // latter, and must come from the type parser ("expected a type").
  for (const src of ["(x: number) -> => x", "(x: number) -> * => x", "(x: number) -> | => x"]) {
    test(`reports at the annotation, not the param colon: ${src}`, () => {
      const err = parseError(src);
      expect(err.message).toContain("expected a type");
      expect(err.col).toBe(16);
    });
  }

  test("well-formed typed lambdas still parse", () => {
    expect(parse("(x: number) -> number => x")).toEqual({
      $sig: { params: [{ type: "number" }], returns: { type: "number" } },
      $params: ["x"],
      $return: { $var: "x" },
    });
  });

  test("a curried function-type return still parses (arrow inside the annotation)", () => {
    expect(parse("(x: number) -> (number) -> number => (y) => x")).toEqual({
      $sig: {
        params: [{ type: "number" }],
        returns: { $fnType: { params: [{ type: "number" }], returns: { type: "number" } } },
      },
      $params: ["x"],
      $return: { $params: ["y"], $return: { $var: "x" } },
    });
  });

  test("a cond arm with a parenthesized guard is not mistaken for a typed lambda", () => {
    expect(parse("cond { (a > b) -> a, else -> b }")).toEqual({
      $cond: [[{ $call: "gt", $args: [{ $var: "a" }, { $var: "b" }] }, { $var: "a" }]],
      $else: { $var: "b" },
    });
  });
});
