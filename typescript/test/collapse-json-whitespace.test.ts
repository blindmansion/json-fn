import { describe, expect, test } from "bun:test";

import { collapseJsonWhitespace } from "../scripts/collapse-json-whitespace";

describe("collapseJsonWhitespace", () => {
  test("removes every kind of JSON whitespace outside strings", () => {
    expect(collapseJsonWhitespace(' \t{\r\n  "value": [1, 2]\n}\n')).toBe('{"value":[1,2]}');
  });

  test("preserves whitespace and escapes inside strings", () => {
    const source = String.raw`{
      "space": "a b",
      "escaped quote": "a\" b",
      "escaped slash": "a\\ b",
      "controls": "\t\n\r"
    }`;

    expect(collapseJsonWhitespace(source)).toBe(
      String.raw`{"space":"a b","escaped quote":"a\" b","escaped slash":"a\\ b","controls":"\t\n\r"}`,
    );
  });

  test("preserves token spelling", () => {
    expect(collapseJsonWhitespace('{ "large": 9007199254740993, "zero": -0 }')).toBe(
      '{"large":9007199254740993,"zero":-0}',
    );
  });
});
