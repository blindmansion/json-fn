import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../../src/builtins";
import type { JSONType } from "../../src/types";
import type { Schema } from "../../src/check/schema";
import { isSubschema } from "../../src/check/subsumption";
import { checkExpr, checkModule } from "../../src/check/module";
import { synth } from "../../src/check/checker";
import type { CheckContext } from "../../src/check/context";

// ---------------------------------------------------------------------------
// Section E — synth (standalone expressions via checkExpr)
// ---------------------------------------------------------------------------

describe("synth: literals & data", () => {
  test("scalars synthesize as const (null as type)", () => {
    expect(checkExpr(42).type).toEqual({ const: 42 });
    expect(checkExpr("active").type).toEqual({ const: "active" });
    expect(checkExpr(true).type).toEqual({ const: true });
    expect(checkExpr(null).type).toEqual({ type: "null" });
  });
  test("array literal synthesizes as a closed tuple", () => {
    expect(checkExpr([1, 2]).type).toEqual({
      type: "array",
      prefixItems: [{ const: 1 }, { const: 2 }],
      items: false,
      minItems: 2,
    });
  });
  test("object literal synthesizes as a closed object", () => {
    expect(checkExpr({ from: 1, to: 2 }).type).toEqual({
      type: "object",
      properties: { from: { const: 1 }, to: { const: 2 } },
      required: ["from", "to"],
      additionalProperties: false,
    });
  });
  test("$raw payload is typed structurally, not evaluated", () => {
    expect(checkExpr({ $raw: { $var: "x" } }).type).toEqual({
      type: "object",
      properties: { $var: { const: "x" } },
      required: ["$var"],
      additionalProperties: false,
    });
  });
  test("a synthesized literal is a subtype of its declared refinement", () => {
    expect(isSubschema(checkExpr(5).type, { type: "integer", minimum: 0 })).toBe(true);
    expect(isSubschema(checkExpr(-5).type, { type: "integer", minimum: 0 })).toBe(false);
  });
});

describe("synth: non-null assertion", () => {
  test("$cast removes null from the operand type", () => {
    const result = checkExpr({
      $cast: { $if: true, $then: 1, $else: null },
    });
    expect(result.type).toEqual({ type: "integer" });
    expect(result.diagnostics).toEqual([]);
  });

  test("$cast of null synthesizes never", () => {
    expect(checkExpr({ $cast: null }).type).toBe(false);
  });
});

describe("synth: visible `any` degradation", () => {
  test("an unresolved variable degrades to any with an info diagnostic", () => {
    const result = checkExpr({ $var: "missing" });
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message: 'expression degraded to `any` because variable "missing" is unresolved.',
        severity: "info",
      },
    ]);
  });

  test("an unknown callee degrades to any with an info diagnostic", () => {
    const result = checkExpr({ $call: "missing", $args: [] });
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message: "expression degraded to `any` because the callee has no known function type.",
        severity: "info",
      },
    ]);
  });

  test("an unknown callee still walks its arguments", () => {
    const { diagnostics } = checkExpr({
      $call: "missing",
      $args: [{ $var: "alsoMissing" }],
    });
    expect(diagnostics.map((d) => [d.path, d.severity])).toEqual([
      [["$args[0]"], "info"],
      [[], "info"],
    ]);
  });

  test("an unresolved string function reference reports its own degradation", () => {
    const result = checkExpr({ $fn: "missing" });
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message: 'expression degraded to `any` because function reference "missing" is unresolved.',
        severity: "info",
      },
    ]);
  });

  test("an unannotated function value reports its missing signature", () => {
    const result = checkExpr({ $params: ["x"], $return: { $var: "x" } });
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message:
          "expression degraded to `any` because the function value has no declared signature.",
        severity: "info",
      },
    ]);
  });

  test("a builtin call with a loaded typing rule does not degrade", () => {
    const call: JSONType = { $call: "add", $args: [1, 2] };
    expect(checkExpr(call, {}, loadBuiltinTable()).diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sections D + E + G — module checking end to end
// ---------------------------------------------------------------------------

// Convenience: a `$sig`-annotated function body.
const body = (
  params: JSONType[],
  sig: { params: Schema[]; returns: Schema; rest?: Schema },
  ret: JSONType,
  locals: Record<string, JSONType> = {},
): Record<string, JSONType> => ({ $sig: sig, $params: params, ...locals, $return: ret });

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };

describe("checkModule: clean programs", () => {
  test("identity + a caller through the registry sig type-check", () => {
    const mod = {
      identity: body(["n"], { params: [I], returns: I }, { $var: "n" }),
      caller: body(
        ["n"],
        { params: [I], returns: I },
        { $call: "identity", $args: [{ $var: "n" }] },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("a $cond over literal results fits a string return", () => {
    const mod = {
      label: body(
        ["n"],
        { params: [I], returns: S },
        {
          $cond: [[{ $var: "n" }, "a"]],
          $else: "b",
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("$get projects a declared property type", () => {
    const mod = {
      $types: {
        Color: { enum: ["w", "b"] },
        State: {
          type: "object",
          properties: { board: { type: "array", items: I }, turn: { $ref: "#/$defs/Color" } },
          required: ["board", "turn"],
          additionalProperties: false,
        },
      },
      getTurn: body(
        ["s"],
        { params: [{ $ref: "#/$defs/State" }], returns: { $ref: "#/$defs/Color" } },
        {
          $get: "turn",
          $from: { $var: "s" },
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("$get on an optional field projects `T | null`", () => {
    const $types = {
      User: {
        type: "object",
        properties: { id: S, score: I },
        required: ["id"], // `score` optional
        additionalProperties: false,
      },
    };
    const userRef = { $ref: "#/$defs/User" };
    const scoreOf = (ret: Schema): Record<string, JSONType> => ({
      $types,
      f: body(["u"], { params: [userRef], returns: ret }, { $get: "score", $from: { $var: "u" } }),
    });

    // Optional access is `integer | null`, so it fits `integer | null` cleanly
    // but not a bare `integer` (absence must be handled).
    expect(checkModule(scoreOf({ type: ["integer", "null"] }))).toEqual([]);
    expect(checkModule(scoreOf(I)).length).toBeGreaterThan(0);

    // A required field keeps its bare type.
    const idOf = body(
      ["u"],
      { params: [userRef], returns: S },
      { $get: "id", $from: { $var: "u" } },
    );
    expect(checkModule({ $types, f: idOf })).toEqual([]);
  });
});

describe("checkModule: diagnostics", () => {
  test("return type mismatch is reported", () => {
    const mod = {
      bad: body(["n"], { params: [I], returns: S }, { $var: "n" }),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["bad", "$return"]);
    expect(diags[0]!.expected).toEqual(S);
    expect(diags[0]!.actual).toEqual(I);
  });

  test("argument type mismatch is reported at the arg path", () => {
    const mod = {
      wantString: body(["s"], { params: [S], returns: S }, { $var: "s" }),
      caller: body(
        ["n"],
        { params: [I], returns: S },
        {
          $call: "wantString",
          $args: [{ $var: "n" }],
        },
      ),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["caller", "$return", "$args[0]"]);
  });

  test("arity mismatch is reported", () => {
    const mod = {
      identity: body(["n"], { params: [I], returns: I }, { $var: "n" }),
      caller: body(
        ["n"],
        { params: [I], returns: I },
        {
          $call: "identity",
          $args: [{ $var: "n" }, { $var: "n" }],
        },
      ),
    };
    const diags = checkModule(mod);
    expect(diags.some((d) => /Expected 1 argument/.test(d.message))).toBe(true);
  });

  test("rest params accept extra arguments of the element type", () => {
    const mod = {
      variadic: body(["...xs"], { params: [], rest: I, returns: I }, 0),
      caller: body([], { params: [], returns: I }, { $call: "variadic", $args: [1, 2, 3] }),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("a rest arg of the wrong element type is reported", () => {
    const mod = {
      variadic: body(["...xs"], { params: [], rest: I, returns: I }, 0),
      caller: body([], { params: [], returns: I }, { $call: "variadic", $args: [1, "two"] }),
    };
    const diags = checkModule(mod);
    expect(diags.some((d) => d.path.join(".") === "caller.$return.$args[1]")).toBe(true);
  });
});

describe("check: bidirectional object literals (Part A)", () => {
  const closed = (props: Record<string, Schema>, required: string[]): Schema => ({
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  });
  // A function returning the given object-literal expression, checked against
  // the given expected object return type.
  const returning = (ret: JSONType, expected: Schema): Record<string, JSONType> => ({
    f: body([], { params: [], returns: expected }, ret),
  });

  test("a well-typed object literal checks clean", () => {
    const mod = returning({ a: 1, b: "s" }, closed({ a: I, b: S }, ["a", "b"]));
    expect(checkModule(mod)).toEqual([]);
  });

  test("an extra field is reported at the offending key, not as a whole-schema dump", () => {
    const mod = returning({ a: 1, b: 2 }, closed({ a: I }, ["a"]));
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return", "b"]);
    expect(diags[0]!.message).toContain("not permitted");
  });

  test("a missing required field is reported at the object", () => {
    const mod = returning({ a: 1 }, closed({ a: I, b: S }, ["a", "b"]));
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(diags[0]!.message).toContain('Required field "b"');
    expect(diags[0]!.expected).toEqual(S);
  });

  test("a field type mismatch is pinpointed to that field", () => {
    const mod = returning({ a: "x" }, closed({ a: I }, ["a"]));
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "a"]);
    expect(diags[0]!.expected).toEqual(I);
    expect(diags[0]!.actual).toEqual({ const: "x" });
  });

  test("a nested object mismatch pinpoints the deep field", () => {
    const inner = closed({ x: I }, ["x"]);
    const mod = returning({ a: { x: "y" } }, closed({ a: inner }, ["a"]));
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "a", "x"]);
  });

  test("a map (additionalProperties) expected pushes the value type into each key", () => {
    const map: Schema = { type: "object", additionalProperties: I };
    const clean = returning({ a: 1, b: 2 }, map);
    expect(checkModule(clean)).toEqual([]);

    const bad = returning({ a: 1, b: "x" }, map);
    const diags = checkModule(bad);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "b"]);
    expect(diags[0]!.expected).toEqual(I);
  });

  test("expected resolves through a $ref alias", () => {
    const mod = {
      $types: { Rec: closed({ a: I }, ["a"]) },
      f: body([], { params: [], returns: { $ref: "#/$defs/Rec" } }, { a: "nope" }),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "a"]);
  });

  test("a union or non-object expected falls back to whole-schema subsumption", () => {
    // Expected is a union; check-mode doesn't decompose it, but the whole-object
    // comparison still reports the mismatch (at the object, not a field).
    const mod = returning({ a: 1 }, { anyOf: [I, S] });
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
  });
});

describe("check: bidirectional array literals (Part A)", () => {
  // A function returning the given array-literal expression, checked against the
  // given expected array/tuple return type.
  const returning = (ret: JSONType, expected: Schema): Record<string, JSONType> => ({
    f: body([], { params: [], returns: expected }, ret),
  });
  const arrayOf = (items: Schema): Schema => ({ type: "array", items });
  const tuple = (items: Schema[], rest?: Schema): Schema => ({
    type: "array",
    prefixItems: items,
    items: rest ?? false,
  });

  test("a well-typed array literal checks clean", () => {
    expect(checkModule(returning([1, 2, 3], arrayOf(I)))).toEqual([]);
  });

  test("an element mismatch is pinpointed to that index", () => {
    const diags = checkModule(returning([1, "x", 3], arrayOf(I)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "[1]"]);
    expect(diags[0]!.expected).toEqual(I);
    expect(diags[0]!.actual).toEqual({ const: "x" });
  });

  test("a nested object-in-array mismatch pinpoints the deep field", () => {
    const inner: Schema = {
      type: "object",
      properties: { x: I },
      required: ["x"],
      additionalProperties: false,
    };
    const diags = checkModule(returning([{ x: "y" }], arrayOf(inner)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "[0]", "x"]);
  });

  test("too few elements is a length error at the array", () => {
    const diags = checkModule(returning([1, 2], { type: "array", items: I, minItems: 3 }));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(diags[0]!.message).toContain("at least 3");
  });

  test("a tuple literal checks positionally and clean", () => {
    expect(checkModule(returning([1, "s"], tuple([I, S])))).toEqual([]);
  });

  test("a tuple element mismatch is pinpointed to that index", () => {
    const diags = checkModule(returning([1, 2], tuple([I, S])));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "[1]"]);
    expect(diags[0]!.expected).toEqual(S);
  });

  test("an element past a closed tuple's arity is not permitted", () => {
    const diags = checkModule(returning([1, 2], tuple([I])));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "[1]"]);
    expect(diags[0]!.message).toContain("not permitted");
  });

  test("a missing tuple position is reported at the array", () => {
    const diags = checkModule(returning([1], tuple([I, S])));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(diags[0]!.message).toContain("element 1 is missing");
    expect(diags[0]!.expected).toEqual(S);
  });

  test("a tuple rest element checks trailing items against the rest schema", () => {
    expect(checkModule(returning([1, "a", "b"], tuple([I], S)))).toEqual([]);
    const diags = checkModule(returning([1, 2], tuple([I], S)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "[1]"]);
    expect(diags[0]!.expected).toEqual(S);
  });

  test("expected resolves through a $ref alias", () => {
    const mod = {
      $types: { Row: arrayOf(I) },
      f: body([], { params: [], returns: { $ref: "#/$defs/Row" } }, ["x"]),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "[0]"]);
  });

  test("a union or non-array expected falls back to whole-schema subsumption", () => {
    const diags = checkModule(returning([1], { anyOf: [arrayOf(S), S] }));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
  });

  test("a uniqueItems constraint the literal can't prove falls back to whole-schema", () => {
    const diags = checkModule(returning([1, 2], { type: "array", items: I, uniqueItems: true }));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
  });
});

describe("check: bidirectional branch arms (Part A)", () => {
  const returning = (ret: JSONType, expected: Schema): Record<string, JSONType> => ({
    f: body([], { params: [], returns: expected }, ret),
  });

  test("$if: arms that both fit the expected type check clean", () => {
    expect(checkModule(returning({ $if: true, $then: 1, $else: 2 }, I))).toEqual([]);
  });

  test("$if: a mismatching arm is pinpointed to that arm, not the whole $return", () => {
    const diags = checkModule(returning({ $if: true, $then: 1, $else: "x" }, I));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "$else"]);
    expect(diags[0]!.expected).toEqual(I);
    expect(diags[0]!.actual).toEqual({ const: "x" });
  });

  test("$if: arms recurse into composite literals (no literal-union widening)", () => {
    const obj: Schema = {
      type: "object",
      properties: { a: I },
      required: ["a"],
      additionalProperties: false,
    };
    const diags = checkModule(returning({ $if: true, $then: { a: 1 }, $else: { a: "x" } }, obj));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "$else", "a"]);
  });

  test("$if: truthiness narrowing threads into the checked arm", () => {
    // x : string | null. On the then-arm `x` is narrowed to string (null dropped
    // by truthiness), so checking each arm against `string` is clean — the fact
    // set reaches check-mode, not only synth.
    const nullable: Schema = { anyOf: [S, { type: "null" }] };
    const mod = {
      f: body(
        ["x"],
        { params: [nullable], returns: S },
        {
          $if: { $var: "x" },
          $then: { $var: "x" },
          $else: "",
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("$cond: a mismatching arm is pinpointed to that arm", () => {
    const diags = checkModule(
      returning(
        {
          $cond: [
            [true, 1],
            [false, "x"],
          ],
          $else: 3,
        },
        I,
      ),
    );
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "$cond[1][1]"]);
    expect(diags[0]!.expected).toEqual(I);
  });

  test("$match: a mismatching case arm is pinpointed to that arm", () => {
    const p: Schema = { enum: ["a", "b"] };
    const mod = {
      f: body(
        ["p"],
        { params: [p], returns: I },
        {
          $match: { $var: "p" },
          $cases: [
            ["a", 1],
            ["b", "x"],
          ],
        },
      ),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "$cases[1][1]"]);
    expect(diags[0]!.expected).toEqual(I);
  });

  test("$match: exhaustiveness lint still fires in checked position", () => {
    const p: Schema = { enum: ["a", "b"] };
    const mod = {
      f: body(
        ["p"],
        { params: [p], returns: I },
        {
          $match: { $var: "p" },
          $cases: [["a", 1]],
        },
      ),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(diags[0]!.message).toContain("Non-exhaustive");
  });
});

describe("check: bidirectional un-annotated lambdas (Part A)", () => {
  const fn = (params: Schema[], returns: Schema, rest?: Schema): Schema => ({
    $fnType: { params, ...(rest !== undefined ? { rest } : {}), returns },
  });
  // An un-annotated inline lambda: `$params` names only, no `$sig`.
  const lambda = (params: JSONType[], ret: JSONType): Record<string, JSONType> => ({
    $params: params,
    $return: ret,
  });
  // A function returning `ret` (a lambda), checked against an expected fn type.
  const returning = (ret: JSONType, expected: Schema): Record<string, JSONType> => ({
    f: body([], { params: [], returns: expected }, ret),
  });

  test("a zero-arg lambda checks against an expected () -> T (capability record)", () => {
    // `() => 1` against `() -> integer` — the field's expected fn type reaches
    // the un-annotated lambda, which previously erased to `any`.
    expect(checkModule(returning(lambda([], 1), fn([], I)))).toEqual([]);
  });

  test("param types flow in: the body checks against the expected params", () => {
    // `(x) => x` against `(integer) -> integer`: `x` binds to integer, clean.
    expect(checkModule(returning(lambda(["x"], { $var: "x" }), fn([I], I)))).toEqual([]);
  });

  test("a body that violates the expected return is pinpointed at the lambda's $return", () => {
    const diags = checkModule(returning(lambda(["x"], { $var: "x" }), fn([I], S)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return", "$return"]);
    expect(diags[0]!.expected).toEqual(S);
    expect(diags[0]!.actual).toEqual(I);
  });

  test("the expected return recurses structurally into a composite body", () => {
    const obj: Schema = {
      type: "object",
      properties: { a: I },
      required: ["a"],
      additionalProperties: false,
    };
    const diags = checkModule(returning(lambda([], { a: "x" }), fn([], obj)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "$return", "a"]);
  });

  test("an arity mismatch is reported at the lambda, not deferred to `any`", () => {
    const diags = checkModule(returning(lambda(["x"], { $var: "x" }), fn([], I)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(diags[0]!.actual).toEqual(fn([true], true));
    expect(diags[0]!.expected).toEqual(fn([], I));
  });

  test("a rest param satisfies an expected rest signature", () => {
    expect(checkModule(returning(lambda(["...xs"], 1), fn([], I, I)))).toEqual([]);
    // …but a fixed-arity lambda does not satisfy an expected rest signature.
    const diags = checkModule(returning(lambda(["x"], { $var: "x" }), fn([], I, I)));
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return"]);
  });

  test("the expected fn type resolves through a $ref alias", () => {
    const mod = {
      $types: { Thunk: fn([], I) },
      f: body([], { params: [], returns: { $ref: "#/$defs/Thunk" } }, lambda([], "nope")),
    };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["f", "$return", "$return"]);
    expect(diags[0]!.expected).toEqual(I);
  });

  test("a non-fn-type expected defers silently (no spurious `any ⊄ …`)", () => {
    // `any` expected can't supply param types; the un-annotated lambda is left
    // untyped rather than dumping a mismatch.
    expect(checkModule(returning(lambda(["x"], { $var: "x" }), true))).toEqual([]);
  });

  test("a lambda argument to a user function is contextually typed", () => {
    // `apply(f, cb)` where `cb`'s param is `(integer) -> integer`; the inline
    // lambda body is checked against integer → clean, or pinpointed on mismatch.
    const mod = {
      apply: body(
        ["cb"],
        { params: [fn([I], I)], returns: I },
        { $call: { $var: "cb" }, $args: [1] },
      ),
      good: body(
        [],
        { params: [], returns: I },
        {
          $call: "apply",
          $args: [lambda(["n"], { $var: "n" })],
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);

    const bad = {
      apply: body(
        ["cb"],
        { params: [fn([I], I)], returns: I },
        { $call: { $var: "cb" }, $args: [1] },
      ),
      caller: body(
        [],
        { params: [], returns: I },
        {
          $call: "apply",
          $args: [lambda(["n"], "x")],
        },
      ),
    };
    const diags = checkModule(bad);
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toEqual(["caller", "$return", "$args[0]", "$return"]);
    expect(diags[0]!.expected).toEqual(I);
  });
});

describe("check: do-block / where IIFE (Part A)", () => {
  // An inline *un-annotated* body callee invoked immediately — the shape the
  // shorthand emits for `expr where { … }` and for a `do { … }` block with
  // leading pure bindings: `{ $call: <body without $sig>, $args: [] }`.
  const iife = (
    ret: JSONType,
    locals: Record<string, JSONType> = {},
    params: JSONType[] = [],
    args: JSONType[] = [],
  ): JSONType => ({
    $call: { ...(params.length ? { $params: params } : {}), ...locals, $return: ret },
    $args: args,
  });

  test("synthesizes the body's $return type, not `any`", () => {
    // `1 where { x: 1 }` → the IIFE result is `x`'s type, previously erased to
    // `any` (callee had no known function type).
    const r = checkExpr(iife({ $var: "x" }, { x: 1 }));
    expect(r.type).toEqual({ const: 1 });
    expect(r.diagnostics).toEqual([]);
  });

  test("params bind to the synthesized argument types", () => {
    // `((n) => n)(5)` inline and un-annotated: `n` binds to the arg's type.
    const r = checkExpr(iife({ $var: "n" }, {}, ["n"], [5]));
    expect(r.type).toEqual({ const: 5 });
    expect(r.diagnostics).toEqual([]);
  });

  test("a nested error inside the body is surfaced within the body scope", () => {
    // The degradation is located at the body's `$return`, not lost at the call.
    const r = checkExpr(iife({ $var: "missing" }));
    expect(r.type).toBe(true);
    expect(r.diagnostics.map((d) => [d.path, d.severity])).toEqual([[["$return"], "info"]]);
  });

  test("an arity mismatch is reported at the call", () => {
    const r = checkExpr(iife({ $var: "n" }, {}, ["n"], []));
    expect(r.diagnostics.some((d) => /Expected 1 argument\(s\), got 0\./.test(d.message))).toBe(
      true,
    );
  });

  test("the expected type is pushed into the body's $return (checked position)", () => {
    // `f: () -> string` whose body is `1 where { x: 1 }`: the integer result is
    // pinpointed at the IIFE body's `$return`, not dumped at the whole call.
    const mod = { f: body([], { params: [], returns: S }, iife({ $var: "x" }, { x: 1 })) };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return", "$return"]);
    expect(diags[0]!.expected).toEqual(S);
    expect(diags[0]!.actual).toEqual({ const: 1 });
  });

  test("a body matching the expected type checks clean", () => {
    const mod = { f: body([], { params: [], returns: I }, iife({ $var: "x" }, { x: 1 })) };
    expect(checkModule(mod)).toEqual([]);
  });

  test("a bind-continuation IIFE retains facts active where its lazy locals are created", () => {
    const nullableString: Schema = { anyOf: [S, { type: "null" }] };
    const taskString: Schema = { $taskType: S };
    const mod = {
      acceptsString: body(["value"], { params: [S], returns: { type: "boolean" } }, true),
      run: body(
        ["cmd"],
        { params: [nullableString], returns: taskString },
        {
          $if: { $call: "isNull", $args: [{ $var: "cmd" }] },
          $then: { $call: "pure", $args: ["none"] },
          $else: {
            $call: "bind",
            $args: [
              { $call: "pure", $args: [null] },
              {
                $params: ["_"],
                $return: iife(
                  {
                    $if: { $var: "accepted" },
                    $then: { $call: "pure", $args: ["yes"] },
                    $else: { $call: "pure", $args: ["no"] },
                  },
                  {
                    accepted: {
                      $call: "acceptsString",
                      $args: [{ $var: "cmd" }],
                    },
                  },
                ),
              },
            ],
          },
        },
      ),
    };

    expect(checkModule(mod, loadBuiltinTable())).toEqual([]);
  });
});

describe("checkModule: dangling $ref → hard error", () => {
  const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });

  test("a `$ref` to an undeclared type in a sig is an error, not a silent top", () => {
    const mod = { f: body([], { params: [], returns: ref("Reprot") }, true) };
    const diags = checkModule(mod);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$sig"]);
    expect(diags[0]!.message).toContain("Reprot");
  });

  test("an intentional `type X = any` alias still checks clean", () => {
    const mod = { $types: { X: true }, g: body([], { params: [], returns: ref("X") }, 1) };
    expect(checkModule(mod)).toEqual([]);
  });

  test("a dangling `$ref` inside a `$types` body is reported at the def", () => {
    const mod = {
      $types: { User: { type: "object", properties: { id: ref("Missing") }, required: ["id"] } },
      main: body([], { params: [], returns: I }, 1),
    };
    const diags = checkModule(mod);
    expect(diags.some((d) => d.path.join(".") === "$types.User" && /Missing/.test(d.message))).toBe(
      true,
    );
  });

  test("refs are covered inside arrays, unions, and `$fnType` leaves", () => {
    const mod = {
      f: body(
        ["xs", "cb"],
        {
          params: [
            { type: "array", items: ref("Foo") },
            { $fnType: { params: [], returns: ref("Bar") } },
          ],
          returns: { anyOf: [ref("Baz"), { type: "null" }] },
        },
        1,
      ),
    };
    const names = new Set(checkModule(mod).map((d) => d.message.match(/"([^"]+)"/)?.[1]));
    expect(names).toEqual(new Set(["Foo", "Bar", "Baz"]));
  });

  test("a nested `where`-local signature is covered too", () => {
    const mod = {
      main: body([], { params: [], returns: I }, 1, {
        helper: body(["x"], { params: [ref("Qux")], returns: I }, { $var: "x" }),
      }),
    };
    const diags = checkModule(mod);
    expect(
      diags.some((d) => d.path.join(".") === "main.helper.$sig" && /Qux/.test(d.message)),
    ).toBe(true);
  });
});

describe("checkModule: require typed module functions (on by default)", () => {
  test("an unannotated top-level function errors by default", () => {
    const mod = { f: { $params: ["n"], $return: { $var: "n" } } };
    const diags = checkModule(mod);
    expect(diags.some((d) => d.severity === "error" && d.path.join(".") === "f")).toBe(true);
    expect(diags.some((d) => /must declare a signature/.test(d.message))).toBe(true);
  });

  test("a `$sig`-annotated top-level function is unaffected", () => {
    const mod = { f: body(["n"], { params: [I], returns: I }, { $var: "n" }) };
    expect(checkModule(mod)).toEqual([]);
  });

  test("`requireTypedModuleFunctions: false` stays permissive but reports lost coverage", () => {
    const mod = { f: { $params: ["n"], $return: { $var: "n" } } };
    expect(checkModule(mod, undefined, { requireTypedModuleFunctions: false })).toEqual([
      {
        path: ["f"],
        message:
          'expression degraded to `any` because module function "f" has no declared signature.',
        severity: "info",
      },
    ]);
  });

  test("nested `where`-locals and inline lambdas stay exempt", () => {
    const mod = {
      main: body(
        [],
        { params: [], returns: true },
        { $call: "helper", $args: [1] },
        {
          helper: { $params: ["x"], $return: { $var: "x" } },
        },
      ),
    };
    const diagnostics = checkModule(mod);
    expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
    expect(diagnostics).toEqual([
      {
        path: ["main", "helper"],
        message:
          'expression degraded to `any` because function binding "helper" has no declared signature.',
        severity: "info",
      },
      {
        path: ["main", "$return"],
        message: "expression degraded to `any` because the callee has no known function type.",
        severity: "info",
      },
    ]);
  });
});

describe("buildTypeScope: lazy locals & cycles", () => {
  test("an un-annotated local is typed lazily from its expression", () => {
    // `doubled` is a where-local with no signature; its type is synthesized on
    // demand and must fit the declared return.
    const mod = {
      f: body(
        ["n"],
        { params: [I], returns: I },
        { $var: "chosen" },
        {
          chosen: { $var: "n" },
        },
      ),
    };
    expect(checkModule(mod)).toEqual([]);
  });

  test("mutually recursive locals are caught as a cycle", () => {
    const mod = { a: { $var: "b" }, b: { $var: "a" } };
    const diags = checkModule(mod);
    expect(diags.some((d) => /Circular local type dependency/.test(d.message))).toBe(true);
  });
});

describe("synth: field projection over a union", () => {
  // A tagged union whose arms share the `tag` discriminant; `n` lives on one arm.
  const F: Schema = {
    anyOf: [
      {
        type: "object",
        properties: { tag: { const: "a" }, n: { type: "integer" } },
        required: ["tag", "n"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { tag: { const: "b" } },
        required: ["tag"],
        additionalProperties: false,
      },
    ],
  };
  const ctxWith = (env: Record<string, Schema>): CheckContext => ({
    defs: {},
    env: { lookupType: (n) => env[n] },
    diagnostics: [],
    path: [],
  });

  test("a shared discriminant projects to the union of its per-arm literals", () => {
    const t = synth({ $get: "tag", $from: { $var: "x" } }, ctxWith({ x: F }));
    expect(t).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] });
  });

  test("a field on only some arms projects to the join, absent arms contributing null", () => {
    const t = synth({ $get: "n", $from: { $var: "x" } }, ctxWith({ x: F }));
    expect(t).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
  });

  test("projection resolves through a $ref union alias", () => {
    const ctx: CheckContext = {
      defs: { F },
      env: { lookupType: (n) => (n === "x" ? { $ref: "#/$defs/F" } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(synth({ $get: "tag", $from: { $var: "x" } }, ctx)).toEqual({
      anyOf: [{ const: "a" }, { const: "b" }],
    });
  });
});

describe("synth: computed index / key projection", () => {
  const N: Schema = { type: "number" };
  const arr: Schema = { type: "array", items: I };
  const map: Schema = { type: "object", additionalProperties: I };
  const ctxWith = (env: Record<string, Schema>): CheckContext => ({
    defs: {},
    env: { lookupType: (n) => env[n] },
    diagnostics: [],
    path: [],
  });
  const get = (from: string, key: JSONType): JSONType => ({ $get: key, $from: { $var: from } });

  test("an integer-typed index projects an array's element type", () => {
    const ctx = ctxWith({ xs: arr, i: I });
    expect(synth(get("xs", { $var: "i" }), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a string-typed key projects a map's value type", () => {
    const ctx = ctxWith({ m: map, k: S });
    expect(synth(get("m", { $var: "k" }), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a computed index over a union of arrays joins their elements", () => {
    const ctx = ctxWith({
      xs: {
        anyOf: [
          { type: "array", items: I },
          { type: "array", items: S },
        ],
      },
      i: I,
    });
    expect(synth(get("xs", { $var: "i" }), ctx)).toEqual({ anyOf: [I, S] });
  });

  test("a computed index over a tuple joins every slot with null (out-of-bounds)", () => {
    const tuple: Schema = { type: "array", prefixItems: [I, S], items: false };
    const ctx = ctxWith({ t: tuple, i: I });
    expect(synth(get("t", { $var: "i" }), ctx)).toEqual({ anyOf: [I, S, { type: "null" }] });
  });

  test("a computed string key over a closed object joins its properties with null", () => {
    const obj: Schema = {
      type: "object",
      properties: { a: I, b: S },
      required: ["a", "b"],
      additionalProperties: false,
    };
    const ctx = ctxWith({ o: obj, k: S });
    expect(synth(get("o", { $var: "k" }), ctx)).toEqual({ anyOf: [I, S, { type: "null" }] });
  });

  test("a string index into an array is a hard error", () => {
    const ctx = ctxWith({ xs: arr, k: S });
    synth(get("xs", { $var: "k" }), ctx);
    expect(ctx.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("a number (integer-overlapping) index is a hard error (§4.5)", () => {
    const ctx = ctxWith({ xs: arr, i: N });
    const t = synth(get("xs", { $var: "i" }), ctx);
    expect(t).toEqual(I); // still projects the element
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
  });

  test("a fractional literal index is a hard error", () => {
    const ctx = ctxWith({ xs: arr });
    synth(get("xs", 2.5), ctx);
    expect(ctx.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("an any-typed key is permissive and still projects the container", () => {
    const ctx = ctxWith({ xs: arr, k: true });
    expect(synth(get("xs", { $var: "k" }), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });
});

describe("synth: missing closed-object field → hard error", () => {
  const closed = (props: Record<string, Schema>, required: string[]): Schema => ({
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  });
  const ctxWith = (
    env: Record<string, Schema>,
    defs: Record<string, Schema> = {},
  ): CheckContext => ({
    defs,
    env: { lookupType: (n) => env[n] },
    diagnostics: [],
    path: [],
  });
  const get = (from: string, key: JSONType): JSONType => ({ $get: key, $from: { $var: from } });

  test("a literal string key absent from a closed object is a hard error", () => {
    const ctx = ctxWith({ o: closed({ name: S }, ["name"]) });
    synth(get("o", "nmae"), ctx);
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
    expect(ctx.diagnostics[0]!.message).toContain("nmae");
    expect(ctx.diagnostics[0]!.path).toEqual(["$get"]);
  });

  test("a present required key is fine", () => {
    const ctx = ctxWith({ o: closed({ name: S }, ["name"]) });
    expect(synth(get("o", "name"), ctx)).toEqual(S);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a declared-but-optional key is fine (projects T | null)", () => {
    const ctx = ctxWith({ o: closed({ name: S, score: I }, ["name"]) });
    expect(synth(get("o", "score"), ctx)).toEqual({ anyOf: [I, { type: "null" }] });
    expect(ctx.diagnostics).toEqual([]);
  });

  test("an open object stays permissive (no error, degrades to any)", () => {
    const open: Schema = { type: "object", properties: { name: S }, required: ["name"] };
    const ctx = ctxWith({ o: open });
    expect(synth(get("o", "whatever"), ctx)).toBe(true);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a map object stays permissive (no error, projects the value type)", () => {
    const map: Schema = { type: "object", additionalProperties: I };
    const ctx = ctxWith({ o: map });
    expect(synth(get("o", "any-key"), ctx)).toEqual(I);
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a union where one arm supplies the key is fine (honest T | null)", () => {
    const u: Schema = {
      anyOf: [closed({ name: S, n: I }, ["name", "n"]), closed({ name: S }, ["name"])],
    };
    const ctx = ctxWith({ o: u });
    expect(synth(get("o", "n"), ctx)).toEqual({ anyOf: [I, { type: "null" }] });
    expect(ctx.diagnostics).toEqual([]);
  });

  test("a union where every arm is closed-missing is a hard error", () => {
    const u: Schema = { anyOf: [closed({ a: I }, ["a"]), closed({ b: S }, ["b"])] };
    const ctx = ctxWith({ o: u });
    synth(get("o", "c"), ctx);
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
  });

  test("the error resolves through a $ref alias", () => {
    const ctx = ctxWith({ o: { $ref: "#/$defs/Rec" } }, { Rec: closed({ name: S }, ["name"]) });
    synth(get("o", "nmae"), ctx);
    expect(ctx.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("a nested path errors at the first closed segment that lacks its key", () => {
    const inner = closed({ x: I }, ["x"]);
    const outer = closed({ a: inner }, ["a"]);
    const ctx = ctxWith({ o: outer });
    // `o.a.y`: `a` exists, but `y` is missing on the (closed) inner object.
    synth({ $get: ["a", "y"], $from: { $var: "o" } }, ctx);
    expect(ctx.diagnostics.length).toBe(1);
    expect(ctx.diagnostics[0]!.severity).toBe("error");
    expect(ctx.diagnostics[0]!.message).toContain("y");
  });

  test("an any / unknown target stays permissive", () => {
    const ctx = ctxWith({});
    expect(synth(get("o", "whatever"), ctx)).toBe(true);
    expect(ctx.diagnostics).toEqual([
      {
        path: ["$from"],
        message: 'expression degraded to `any` because variable "o" is unresolved.',
        severity: "info",
      },
    ]);
  });
});

describe("synth: control-flow unions", () => {
  test("$if widens literal branch results before joining them", () => {
    const ctx: CheckContext = {
      defs: {},
      env: { lookupType: () => undefined },
      diagnostics: [],
      path: [],
    };
    const t = synth({ $if: true, $then: 1, $else: "x" }, ctx);
    expect(t).toEqual({ anyOf: [{ type: "integer" }, { type: "string" }] });
    expect(synth({ $if: true, $then: 10, $else: 20 }, ctx)).toEqual({ type: "integer" });
  });

  test("$if narrows a bare-value condition by truthiness in each branch", () => {
    // `if x then x else "d"` where `x: string | null`: the then-branch sees the
    // truthy slice of `x` (null dropped), mirroring the `x || "d"` idiom.
    const nctx: CheckContext = {
      defs: {},
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(synth({ $if: { $var: "x" }, $then: { $var: "x" }, $else: "d" }, nctx)).toEqual({
      type: "string",
    });
  });

  test("$if surfaces the falsy slice on the else-branch", () => {
    // `if x then "d" else x`: the else-branch keeps only `x`'s falsy slice
    // (`"" | null`).
    const nctx: CheckContext = {
      defs: {},
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
      diagnostics: [],
      path: [],
    };
    expect(synth({ $if: { $var: "x" }, $then: "d", $else: { $var: "x" } }, nctx)).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });
});

describe("synth: short-circuit $and / $or are value-returning", () => {
  const ctx: CheckContext = {
    defs: {},
    env: { lookupType: () => undefined },
    diagnostics: [],
    path: [],
  };

  test("$and yields the last operand when earlier ones can't be falsy", () => {
    // `1 && 2` evaluates to `2`; the truthy `1` can never be the result.
    expect(synth({ $and: [1, 2] }, ctx)).toEqual({ const: 2 });
  });

  test("$or yields the last operand when earlier ones can't be truthy", () => {
    // `0 || 5` evaluates to `5`; the falsy `0` can never be the result.
    expect(synth({ $or: [0, 5] }, ctx)).toEqual({ const: 5 });
  });

  test("boolean operands split by truthiness (true && false : false)", () => {
    expect(synth({ $and: [true, false] }, ctx)).toEqual({ const: false });
  });

  test("$or over a nullable subject drops null from the non-final operand", () => {
    // The null-coalescing idiom: `(x: string | null) || "def"` is `string`;
    // the primitive arm already contains the literal fallback.
    const nctx: CheckContext = {
      ...ctx,
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
    };
    expect(synth({ $or: [{ $var: "x" }, "def"] }, nctx)).toEqual({ type: "string" });
  });

  test("$and over a nullable subject keeps only its falsy slice, plus the tail", () => {
    // `(x: string | null) && upper(x)` : the falsy slice of `x` is `"" | null`.
    const nctx: CheckContext = {
      ...ctx,
      env: { lookupType: (n) => (n === "x" ? { type: ["string", "null"] } : undefined) },
    };
    expect(synth({ $and: [{ $var: "x" }, "tail"] }, nctx)).toEqual({
      anyOf: [{ const: "" }, { type: "null" }, { const: "tail" }],
    });
  });

  test("empty $and is true, empty $or is false", () => {
    expect(synth({ $and: [] }, ctx)).toEqual({ const: true });
    expect(synth({ $or: [] }, ctx)).toEqual({ const: false });
  });
});

describe("declared return type is enforced outside the module path", () => {
  const BT = loadBuiltinTable();

  test("checkExpr: a standalone typed lambda checks its body vs the declared return", () => {
    // `(n: integer) -> string => n`: the body is integer, disjoint from string.
    const { diagnostics } = checkExpr(body(["n"], { params: [I], returns: S }, { $var: "n" }));
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]!.severity).toBe("error");
    expect(diagnostics[0]!.path).toEqual(["$return"]);
  });

  test("checkExpr: a well-typed standalone lambda is clean", () => {
    expect(checkExpr(body(["n"], { params: [I], returns: I }, { $var: "n" })).diagnostics).toEqual(
      [],
    );
  });

  test("inline typed lambda in a builtin call honors its own declared return", () => {
    // `map((n: integer) -> string => n, [1,2,3])`: the callback body violates
    // its self-declared `-> string`.
    const call = {
      $call: "map",
      $args: [body(["n", "i"], { params: [I, I], returns: S }, { $var: "n" }), [1, 2, 3]],
    };
    expect(checkExpr(call, {}, BT).diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("inline typed lambda with a matching declared return is clean", () => {
    const call = {
      $call: "map",
      $args: [body(["n", "i"], { params: [I, I], returns: I }, { $var: "n" }), [1, 2, 3]],
    };
    expect(checkExpr(call, {}, BT).diagnostics).toEqual([]);
  });
});
