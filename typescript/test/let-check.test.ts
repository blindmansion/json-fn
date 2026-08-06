import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../src/builtins";
import { checkExpr, checkModule } from "../src/check/module";
import type { JSONType } from "../src/types";
import { parseExpression as parse } from "../src/shorthand";

// The observable checker semantics of `$let` locals — validation, scope,
// recursion, narrowing through named guards and lazy bindings, captures, and
// structural inline calls — are covered by the shared conformance suites
// under `spec/cases/check/locals/`. The tests below remain local because the
// canonical path mapping produced by shorthand lowering (`where` and `do`
// sugar) is itself the assertion, which is a parser/checker integration
// concern rather than portable checker behavior.

describe("shorthand lowering to $let (parser/checker integration)", () => {
  test("keeps shorthand where diagnostics on canonical $let and $in paths", () => {
    const result = checkModule({
      f: parse("() -> integer => value where { value: missing }"),
    });
    expect(result).toContainEqual(
      expect.objectContaining({ path: ["f", "$return", "$let", "value"] }),
    );
    expect(result).toContainEqual(expect.objectContaining({ path: ["f", "$return", "$in"] }));
  });

  test("checks function-body where and pure do bindings structurally", () => {
    const fnBody = parse("(x: integer) -> integer => y where { y: x + 1 }") as Record<
      string,
      JSONType
    >;
    expect(fnBody.$return).toHaveProperty("$let");
    expect(checkExpr(fnBody, {}, loadBuiltinTable()).diagnostics).toEqual([]);

    const doExpr = parse("do { x: 1, pure(x) }") as Record<string, JSONType>;
    expect(doExpr).toHaveProperty("$let");
    expect(checkExpr(doExpr, {}, loadBuiltinTable()).diagnostics).toEqual([]);
  });
});
