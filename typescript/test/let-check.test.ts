import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../src/builtins";
import { checkExpr, checkModule } from "../src/check/module";
import type { JSONType } from "../src/types";
import type { Schema } from "../src/schema/schema.ts";
import { parse } from "../src/shorthand";

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };
const B: Schema = { type: "boolean" };

const letExpr = (bindings: Record<string, JSONType>, result: JSONType): JSONType => ({
  $let: bindings,
  $in: result,
});

const fn = (
  params: JSONType[],
  required: Schema[],
  returns: Schema,
  result: JSONType,
  extra: Record<string, JSONType> = {},
): Record<string, JSONType> => ({
  $params: params,
  $sig: { required, optional: [], returns },
  ...extra,
  $return: result,
});

describe("$let checker validation and result typing", () => {
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

  test("synthesizes the result in a lazy recursive scope", () => {
    const result = checkExpr(letExpr({ x: 1, unused: { $var: "missing" } }, { $var: "x" }));
    expect(result.type).toEqual({ const: 1 });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    [{ $let: { x: 1 } }, [], "must have both $let and $in"],
    [{ $in: 1 }, [], "must have both $let and $in"],
    [{ $let: null, $in: 1 }, ["$let"], "$let must be a non-null object"],
    [{ $let: [], $in: 1 }, ["$let"], "$let must be a non-null object"],
    [{ $let: {}, $in: 1 }, ["$let"], "$let must contain at least one binding"],
    [{ $let: { x: 1 }, $in: 1, extra: true }, [], "cannot have other properties"],
    [{ $let: { x: 1 }, $in: 1, $call: "x" }, [], "cannot have other properties"],
  ] satisfies [JSONType, string[], string][])(
    "reports malformed outer shape %#",
    (expression, path, message) => {
      const result = checkExpr(expression);
      expect(result.type).toBe(true);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ path, message: expect.stringContaining(message) }),
      ]);
    },
  );

  test("does not classify the inside of an unused binding", () => {
    expect(checkExpr(letExpr({ unused: { $let: {} } }, "ok"))).toEqual({
      type: { const: "ok" },
      diagnostics: [],
    });
  });

  test("checks $in directly against the expected return schema", () => {
    const diagnostics = checkModule({
      f: fn([], [], I, letExpr({ value: "wrong" }, { $var: "value" })),
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ path: ["f", "$return", "$in"], severity: "error" }),
    );
  });

  test("roots binding diagnostics under $let.<name>", () => {
    const result = checkExpr(letExpr({ value: { $var: "missing" } }, { $var: "value" }));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ path: ["$let", "value"], severity: "info" }),
    ]);
  });
});

describe("$let recursive scope", () => {
  test("sees parameters and shadows parameters and nested let bindings", () => {
    const resultSchema: Schema = {
      type: "array",
      prefixItems: [S, { const: 2 }, S],
      items: false,
      minItems: 3,
    };
    const diagnostics = checkModule({
      f: fn(
        ["value"],
        [S],
        resultSchema,
        letExpr({ local: { $var: "value" }, value: "shadowed" }, [
          { $var: "local" },
          letExpr({ value: 2 }, { $var: "value" }),
          { $var: "value" },
        ]),
      ),
    });
    expect(diagnostics).toEqual([]);
  });

  test("reports direct and indirect cycles once with stable paths", () => {
    const direct = checkExpr(letExpr({ a: { $var: "a" } }, { $var: "a" }));
    expect(direct.diagnostics).toEqual([
      expect.objectContaining({
        path: ["$let", "a"],
        message: "Circular local type dependency: a -> a",
      }),
    ]);

    const indirect = checkExpr(letExpr({ a: { $var: "b" }, b: { $var: "a" } }, { $var: "a" }));
    expect(indirect.diagnostics).toEqual([
      expect.objectContaining({
        path: ["$let", "a"],
        message: "Circular local type dependency: a -> b -> a",
      }),
    ]);
  });

  test("registers typed recursive and mutually recursive functions eagerly", () => {
    const recursive = fn(["n"], [I], I, {
      $if: { $call: "eq", $args: [{ $var: "n" }, 0] },
      $then: 0,
      $else: { $call: "count", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
    });
    const even = fn(["n"], [I], B, {
      $call: "odd",
      $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }],
    });
    const odd = fn(["n"], [I], B, {
      $if: { $call: "eq", $args: [{ $var: "n" }, 0] },
      $then: false,
      $else: { $call: "even", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
    });
    const result = checkExpr(
      letExpr({ count: recursive, even, odd }, [
        { $call: "count", $args: [2] },
        { $call: { $fn: "even" }, $args: [2] },
        { $var: "odd" },
      ]),
      {},
      loadBuiltinTable(),
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("makes unannotated function degradation visible at its binding", () => {
    const result = checkExpr(letExpr({ helper: { $params: [], $return: 1 } }, { $var: "helper" }));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: ["$let", "helper"], severity: "info" }),
    );
  });

  test("supports bindings whose names collide with object prototypes", () => {
    for (const name of ["toString", "constructor", "__proto__"]) {
      const expression = JSON.parse(
        JSON.stringify({ $let: { placeholder: 1 }, $in: { $var: name } }).replace(
          "placeholder",
          name,
        ),
      ) as JSONType;
      const result = checkExpr(expression);
      expect(result.type).toEqual({ const: 1 });
      expect(result.diagnostics).toEqual([]);
    }
  });

  test("classifies a mixed $let binding as malformed when forced", () => {
    const result = checkExpr(
      letExpr(
        {
          bad: { $let: { x: 1 }, $in: 1, $return: 1 },
        },
        { $var: "bad" },
      ),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: ["$let", "bad"],
        message: "$let expressions cannot have other properties.",
      }),
    ]);
  });
});

describe("$let narrowing", () => {
  const numberOrString: Schema = { anyOf: [I, S] };

  test("a named boolean guard narrows its referenced outer value", () => {
    const diagnostics = checkModule(
      {
        f: fn(
          ["value"],
          [numberOrString],
          I,
          letExpr(
            { integer: { $call: "isInteger", $args: [{ $var: "value" }] } },
            {
              $if: { $var: "integer" },
              $then: { $call: "add", $args: [{ $var: "value" }, 1] },
              $else: 0,
            },
          ),
        ),
      },
      loadBuiltinTable(),
    );
    expect(diagnostics).toEqual([]);
  });

  test("uses creation-site and forcing-site facts for lazy bindings", () => {
    const creationSite = fn(["value"], [numberOrString], I, {
      $if: { $call: "isInteger", $args: [{ $var: "value" }] },
      $then: letExpr({ copy: { $var: "value" } }, { $call: "add", $args: [{ $var: "copy" }, 1] }),
      $else: 0,
    });
    const forcingSite = fn(
      ["value"],
      [numberOrString],
      I,
      letExpr(
        { copy: { $var: "value" } },
        {
          $if: { $call: "isInteger", $args: [{ $var: "value" }] },
          $then: { $call: "add", $args: [{ $var: "copy" }, 1] },
          $else: 0,
        },
      ),
    );
    expect(checkModule({ creationSite, forcingSite }, loadBuiltinTable())).toEqual([]);
  });

  test("retains creation-site facts across a callback boundary", () => {
    const nullableString: Schema = { anyOf: [S, { type: "null" }] };
    const taskString: Schema = { $taskType: S };
    const diagnostics = checkModule(
      {
        acceptsString: fn(["value"], [S], B, true),
        run: fn(["cmd"], [nullableString], taskString, {
          $if: { $call: "isNull", $args: [{ $var: "cmd" }] },
          $then: { $call: "pure", $args: ["none"] },
          $else: {
            $call: "bind",
            $args: [
              { $call: "pure", $args: [null] },
              {
                $params: ["_"],
                $return: letExpr(
                  {
                    accepted: {
                      $call: "acceptsString",
                      $args: [{ $var: "cmd" }],
                    },
                  },
                  {
                    $if: { $var: "accepted" },
                    $then: { $call: "pure", $args: ["yes"] },
                    $else: { $call: "pure", $args: ["no"] },
                  },
                ),
              },
            ],
          },
        }),
      },
      loadBuiltinTable(),
    );
    expect(diagnostics).toEqual([]);
  });

  test("nested let shadowing masks an outer same-named fact", () => {
    const diagnostics = checkModule(
      {
        f: fn(["value"], [numberOrString], S, {
          $if: { $call: "isInteger", $args: [{ $var: "value" }] },
          $then: letExpr(
            { result: letExpr({ value: "inner" }, { $var: "value" }) },
            { $var: "result" },
          ),
          $else: "fallback",
        }),
      },
      loadBuiltinTable(),
    );
    expect(diagnostics).toEqual([]);
  });

  test("function bindings shadow outer named guards", () => {
    const inner = fn([], [], B, true);
    const diagnostics = checkModule(
      {
        f: fn(
          ["value"],
          [numberOrString],
          I,
          letExpr(
            { same: { $call: "isInteger", $args: [{ $var: "value" }] } },
            letExpr(
              { same: inner },
              {
                $if: { $var: "same" },
                $then: { $call: "add", $args: [{ $var: "value" }, 1] },
                $else: 0,
              },
            ),
          ),
        ),
      },
      loadBuiltinTable(),
    );
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("function parameters and captures mask outer narrowing facts", () => {
    const captured = fn([], [], I, 1);
    const capturedType: Schema = {
      $fnType: { required: [], optional: [], returns: I },
    };
    const helper = fn(["value"], [S], S, { $var: "value" });
    const worker = fn(
      [],
      [],
      capturedType,
      { $var: "value" },
      {
        $captures: { value: captured },
      },
    );
    const diagnostics = checkModule(
      {
        f: fn(["value"], [numberOrString], I, {
          $if: { $call: "isInteger", $args: [{ $var: "value" }] },
          $then: letExpr({ helper, worker }, 1),
          $else: 0,
        }),
      },
      loadBuiltinTable(),
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("function captures in the checker", () => {
  const helper = fn([], [], I, 7);

  test("captures are visible to defaults and $return", () => {
    const body: Record<string, JSONType> = {
      $params: [{ $param: "value", $default: { $call: "helper", $args: [] } }],
      $sig: { required: [], optional: [I], returns: I },
      $captures: { helper },
      $return: { $call: "helper", $args: [] },
    };
    expect(checkExpr(body).diagnostics).toEqual([]);
  });

  test.each([
    [null, ["$captures"], "function $captures must be a non-null object"],
    [[], ["$captures"], "function $captures must be a non-null object"],
    [1, ["$captures"], "function $captures must be a non-null object"],
    [{ helper: 1 }, ["$captures", "helper"], 'function capture "helper" must be a function body'],
  ] satisfies [JSONType, string[], string][])(
    "reports malformed captures %#",
    (captures, path, message) => {
      const result = checkExpr(fn([], [], I, 1, { $captures: captures }));
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ path, message: expect.stringContaining(message) }),
      );
    },
  );

  test("walks signatures nested under $let and $captures for dangling refs", () => {
    const missing: Schema = { $ref: "#/$defs/Missing" };
    const nested = fn([], [], missing, 1);
    const diagnostics = checkModule({
      entry: fn([], [], I, letExpr({ local: nested }, 1), { $captures: { captured: nested } }),
    });
    expect(diagnostics.filter((d) => d.message.includes("undefined type"))).toHaveLength(2);
    expect(diagnostics.map((d) => d.path)).toContainEqual([
      "entry",
      "$captures",
      "captured",
      "$sig",
    ]);
    expect(diagnostics.map((d) => d.path)).toContainEqual([
      "entry",
      "$return",
      "$let",
      "local",
      "$sig",
    ]);
  });
});

describe("structural inline calls", () => {
  test("retains contextual typing for a genuine parameterized IIFE", () => {
    const result = checkExpr({
      $call: { $params: ["value"], $return: { $var: "value" } },
      $args: [4],
    });
    expect(result.type).toEqual({ const: 4 });
    expect(result.diagnostics).toEqual([]);
  });

  test("contextual builtin callbacks see evaluator captures", () => {
    const helper = fn(["value"], [I], I, { $var: "value" });
    const result = checkExpr(
      {
        $call: "map",
        $args: [
          {
            $params: ["value"],
            $captures: { helper },
            $return: { $call: "helper", $args: [{ $var: "value" }] },
          },
          [1, 2],
        ],
      },
      {},
      loadBuiltinTable(),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.type).toEqual({ type: "array", items: I });
  });
});
