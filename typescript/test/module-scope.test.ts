import { describe, expect, test } from "bun:test";
import { callProgram, createStdlib } from "../src";
import type { JSONType } from "../src";

const stdlib = createStdlib();

// A canonical inline function that adds 1, for feeding to stdlib higher-order fns.
const addOne = { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, 1] } };

describe("callProgram — module scope", () => {
  test("top-level constant read via $var", () => {
    const module: Record<string, JSONType> = {
      W: 20,
      readW: { $return: { $var: "W" } },
    };
    expect(callProgram(module, "readW", [], stdlib)).toBe(20);
  });

  test("top-level function reads a top-level constant", () => {
    const module: Record<string, JSONType> = {
      W: 20,
      double: { $return: { $fn: ["mul", { $var: "W" }, 2] } },
    };
    expect(callProgram(module, "double", [], stdlib)).toBe(40);
  });

  test("constant depending on another constant (SIZE: mul(W, H))", () => {
    const module: Record<string, JSONType> = {
      W: 20,
      H: 12,
      SIZE: { $fn: ["mul", { $var: "W" }, { $var: "H" }] },
      readSize: { $return: { $var: "SIZE" } },
    };
    expect(callProgram(module, "readSize", [], stdlib)).toBe(240);
  });

  test("dead constant is never evaluated", () => {
    // `boom` would throw if forced, but no captured function references it.
    const module: Record<string, JSONType> = {
      boom: { $var: "doesNotExist" },
      live: 7,
      readLive: { $return: { $var: "live" } },
    };
    expect(callProgram(module, "readLive", [], stdlib)).toBe(7);
  });

  test("$var cycle is detected", () => {
    const module: Record<string, JSONType> = {
      a: { $var: "b" },
      b: { $var: "a" },
      entry: { $return: { $var: "a" } },
    };
    expect(() => callProgram(module, "entry", [], stdlib)).toThrow(/Circular variable dependency/);
  });

  test("module binding shadows a same-named stdlib entry", () => {
    const module: Record<string, JSONType> = {
      add: { $params: ["a", "b"], $return: 999 },
      entry: {
        $params: ["x", "y"],
        $return: { $fn: ["add", { $var: "x" }, { $var: "y" }] },
      },
    };
    expect(callProgram(module, "entry", [1, 2], stdlib)).toBe(999);
  });
});

describe("callProgram — inner binders shadow module constants", () => {
  test("a param masks a module constant of the same name", () => {
    const module: Record<string, JSONType> = {
      W: 20,
      usesParam: { $params: ["W"], $return: { $var: "W" } },
    };
    expect(callProgram(module, "usesParam", [7], stdlib)).toBe(7);
  });

  test("a nested inner function reintroducing the name masks the module constant", () => {
    const module: Record<string, JSONType> = {
      W: 20,
      outer: {
        $return: { $fn: ["inner", 5] },
        inner: { $params: ["W"], $return: { $var: "W" } },
      },
    };
    expect(callProgram(module, "outer", [], stdlib)).toBe(5);
  });
});

describe("callProgram — Lisp-2 asymmetry", () => {
  test("module constant named map: $var sees the constant, $fn calls stdlib", () => {
    const module: Record<string, JSONType> = {
      map: 42,
      readVar: { $return: { $var: "map" } },
      callStdlib: {
        $params: ["xs"],
        $return: { $fn: ["map", addOne, { $var: "xs" }] },
      },
    };
    expect(callProgram(module, "readVar", [], stdlib)).toBe(42);
    expect(callProgram(module, "callStdlib", [[1, 2, 3]], stdlib)).toEqual([2, 3, 4]);
  });

  test("module function named map: both $var and $fn resolve the module function", () => {
    const module: Record<string, JSONType> = {
      map: { $params: ["f", "xs"], $return: "shadowed" },
      readVar: { $return: { $var: "map" } },
      callFn: {
        $params: ["xs"],
        $return: { $fn: ["map", addOne, { $var: "xs" }] },
      },
    };
    // $var map resolves to the (captured) module function value.
    const asValue = callProgram(module, "readVar", [], stdlib);
    expect(typeof asValue).toBe("object");
    expect((asValue as Record<string, JSONType>).$return).toBe("shadowed");
    // $fn map resolves the module function, not stdlib map.
    expect(callProgram(module, "callFn", [[1, 2, 3]], stdlib)).toBe("shadowed");
  });
});

describe("callProgram — module function passed as a value", () => {
  const module: Record<string, JSONType> = {
    cellGlyph: { $params: ["c"], $return: { $if: { $var: "c" }, $then: "X", $else: "." } },
    // $var form: bare reference resolves to the captured function value.
    renderVar: {
      $params: ["row"],
      $return: { $fn: ["map", { $var: "cellGlyph" }, { $var: "row" }] },
    },
    // &-reference form: non-array $fn resolves the name against the function table.
    renderRef: {
      $params: ["row"],
      $return: { $fn: ["map", { $fn: "cellGlyph" }, { $var: "row" }] },
    },
  };

  test("$var form (cellGlyph)", () => {
    expect(callProgram(module, "renderVar", [[true, false, true]], stdlib)).toEqual([
      "X",
      ".",
      "X",
    ]);
  });

  test("&-reference form (&cellGlyph)", () => {
    expect(callProgram(module, "renderRef", [[true, false, true]], stdlib)).toEqual([
      "X",
      ".",
      "X",
    ]);
  });
});

describe("callProgram — entry validation", () => {
  const module: Record<string, JSONType> = {
    k: 5,
    real: { $return: 1 },
  };

  test("unknown entry throws", () => {
    expect(() => callProgram(module, "nope", [], stdlib)).toThrow(
      /not a function defined by the module/,
    );
  });

  test("non-function constant entry throws", () => {
    expect(() => callProgram(module, "k", [], stdlib)).toThrow(
      /not a function defined by the module/,
    );
  });

  test("entry colliding with a stdlib name but absent from module throws (no silent fallback)", () => {
    expect(() => callProgram(module, "map", [], stdlib)).toThrow(
      /not a function defined by the module/,
    );
  });
});
