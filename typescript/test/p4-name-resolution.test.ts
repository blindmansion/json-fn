import { describe, expect, test } from "bun:test";
import { callFunction, callProgram, createStdlib } from "../src";
import type { FunctionDeclaration, FunctionRegistry, JSONType } from "../src";

const functions: FunctionRegistry = createStdlib();
const stdlib = createStdlib();

// P4 + bare references: unified name resolution. A function-valued lexical
// binding (parameter, where-local, module binding) shadows a same-named global
// consistently across operators, direct calls, and bare references; a bare
// registry name in value position resolves to its `&`-free reference.

describe("P4 — lexical-first resolution in call position", () => {
  test("param shadows an operator (x+1 uses the passed `add`)", () => {
    // f:(add,x)=> x+1 ; called with add := &sub, x := 10 ⇒ sub(10,1) = 9.
    const f: FunctionDeclaration = {
      $params: ["add", "x"],
      $return: { $fn: ["add", { $var: "x" }, 1] },
    };
    expect(callFunction(f, ["sub", 10], functions)).toBe(9);
  });

  test("param shadows a stdlib function in a direct call", () => {
    // f:(map)=> map(2) ; map := (x)=> mul(x,10) ⇒ 20 (stdlib map would error).
    const f: FunctionDeclaration = {
      $params: ["map"],
      $return: { $fn: ["map", 2] },
    };
    const times10: JSONType = { $params: ["x"], $return: { $fn: ["mul", { $var: "x" }, 10] } };
    expect(callFunction(f, [times10], functions)).toBe(20);
  });

  test("where-local shadows stdlib `length`", () => {
    const f: FunctionDeclaration = {
      $params: ["x"],
      length: { $params: ["v"], $return: 999 },
      $return: { $fn: ["length", { $var: "x" }] },
    };
    expect(callFunction(f, [[1, 2, 3]], functions)).toBe(999);
  });

  test("non-function local named like a builtin does NOT hijack the operator", () => {
    // add: 5 is a value binding, so x+1 falls through to stdlib add ⇒ 11.
    const f: FunctionDeclaration = {
      $params: ["x"],
      add: 5,
      $return: { $fn: ["add", { $var: "x" }, 1] },
    };
    expect(callFunction(f, [10], functions)).toBe(11);
  });

  test("module binding shadows a same-named stdlib entry (regression)", () => {
    const module: Record<string, JSONType> = {
      add: { $params: ["a", "b"], $return: 999 },
      entry: { $params: ["x", "y"], $return: { $fn: ["add", { $var: "x" }, { $var: "y" }] } },
    };
    expect(callProgram(module, "entry", [1, 2], stdlib)).toBe(999);
  });
});

describe("P4 — local recursion preserved (regression canary)", () => {
  test("local recursive factorial", () => {
    const outer: FunctionDeclaration = {
      $params: ["n"],
      fact: {
        $params: ["m"],
        $return: {
          $if: { $lte: [{ $var: "m" }, 1] },
          $then: 1,
          $else: {
            $fn: ["mul", { $var: "m" }, { $fn: ["fact", { $fn: ["sub", { $var: "m" }, 1] }] }],
          },
        },
      },
      $return: { $fn: ["fact", { $var: "n" }] },
    };
    expect(callFunction(outer, [5], functions)).toBe(120);
  });

  test("mutual recursion (isEven / isOdd)", () => {
    const outer: FunctionDeclaration = {
      $params: ["n"],
      isEven: {
        $params: ["m"],
        $return: {
          $if: { $eq: [{ $var: "m" }, 0] },
          $then: true,
          $else: { $fn: ["isOdd", { $fn: ["sub", { $var: "m" }, 1] }] },
        },
      },
      isOdd: {
        $params: ["m"],
        $return: {
          $if: { $eq: [{ $var: "m" }, 0] },
          $then: false,
          $else: { $fn: ["isEven", { $fn: ["sub", { $var: "m" }, 1] }] },
        },
      },
      $return: { $fn: ["isEven", { $var: "n" }] },
    };
    expect(callFunction(outer, [10], functions)).toBe(true);
    expect(callFunction(outer, [7], functions)).toBe(false);
  });
});

describe("P4 Site 2 — param shadow survives an escaping closure (Option A)", () => {
  const times10: FunctionDeclaration = {
    $params: ["x"],
    $return: { $fn: ["mul", { $var: "x" }, 10] },
  };
  const inc: FunctionDeclaration = { $params: ["n"], $return: { $fn: ["add", { $var: "n" }, 1] } };

  test("a param named like a stdlib builtin (`map`) is captured into the returned lambda", () => {
    // f:(map)=> (x)=> map(x). The returned lambda escapes f's scope; `map` must
    // resolve to the passed param, not stdlib map, when later invoked.
    const f: FunctionDeclaration = {
      $params: ["map"],
      $return: { $params: ["x"], $return: { $fn: ["map", { $var: "x" }] } },
    };
    const lambda = callFunction(f, [times10], functions) as FunctionDeclaration;
    expect(callFunction(lambda, [5], functions)).toBe(50);
  });

  test("compose captures both function params (including a stdlib-colliding name)", () => {
    // compose:(add,g)=> (x)=> add(g(x)); add := &times10 shadows stdlib add.
    const compose: FunctionDeclaration = {
      $params: ["add", "g"],
      $return: {
        $params: ["x"],
        $return: { $fn: ["add", { $fn: ["g", { $var: "x" }] }] },
      },
    };
    const composed = callFunction(compose, [times10, inc], functions) as FunctionDeclaration;
    // times10(inc(5)) = times10(6) = 60
    expect(callFunction(composed, [5], functions)).toBe(60);
  });

  test("combinator with non-colliding names still works (P1 regression)", () => {
    // twice:(g,x)=> g(g(x))
    const twice: FunctionDeclaration = {
      $params: ["g", "x"],
      $return: { $fn: ["g", { $fn: ["g", { $var: "x" }] }] },
    };
    expect(callFunction(twice, [inc, 5], functions)).toBe(7);
  });
});

describe("Bare registry names as references (value position)", () => {
  test("a bare stdlib name resolves to its `&`-free reference", () => {
    const f: FunctionDeclaration = { $return: { $var: "length" } };
    expect(callFunction(f, [], functions)).toBe("length");
  });

  test("`map(length, xss)` works without `&`", () => {
    const f: FunctionDeclaration = {
      $params: ["xss"],
      $return: { $fn: ["map", { $var: "length" }, { $var: "xss" }] },
    };
    expect(
      callFunction(
        f,
        [
          [
            [1, 2],
            [3, 4, 5],
          ],
        ],
        functions,
      ),
    ).toEqual([2, 3]);
  });

  test("a local binding shadows the stdlib name in value position", () => {
    const f: FunctionDeclaration = { $params: ["x"], length: 42, $return: { $var: "length" } };
    expect(callFunction(f, [7], functions)).toBe(42);
  });

  test("`length.foo` still errors (path guard, no ref-then-walk)", () => {
    const f: FunctionDeclaration = { $return: { $var: "length.foo" } };
    expect(() => callFunction(f, [], functions)).toThrow(/Variable length not found/);
  });

  test("an unknown bare name still errors", () => {
    const f: FunctionDeclaration = { $return: { $var: "definitelyNotRegistered" } };
    expect(() => callFunction(f, [], functions)).toThrow(
      /Variable definitelyNotRegistered not found/,
    );
  });
});
