import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../../src/builtins";
import type { JSONType } from "../../src/types";
import { type Defs, type Schema } from "../../src/schema/schema.ts";
import { checkModule } from "../../src/check/module";

// Convenience: a `$sig`-annotated function body.
const body = (
  params: JSONType[],
  sig: { required: Schema[]; optional: Schema[]; returns: Schema; rest?: Schema },
  ret: JSONType,
  bindings: Record<string, JSONType> = {},
): Record<string, JSONType> => ({
  $sig: sig,
  $params: params,
  $return: Object.keys(bindings).length === 0 ? ret : { $let: bindings, $in: ret },
});

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };

// ---------------------------------------------------------------------------
// Real-program fragments: the chess example, worked up in tiers.
//
// Rather than hand-annotate the whole 40-function module at once, we build up
// from the smallest self-contained pieces. Each tier exercises the checker (and
// the builtin table) against code that actually appears in `examples/chess.jfn`,
// lowered to canonical JSON with `$sig`s and a module `$types` pool added.
//
// Tier 1 — the pure coordinate layer: integer/boolean arithmetic with no
// nullability and no name-union dispatch. This is the cleanest slice and should
// type with zero diagnostics.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 1: coordinate layer", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const B: Schema = { type: "boolean" };
  const Color: Schema = { $ref: "#/$defs/Color" };
  const types: Defs = { Color: { enum: ["w", "b"] } };

  const v = (name: string): JSONType => ({ $var: name });

  test("rowOf: floor(idx / 8) : integer", () => {
    const mod = {
      $types: types,
      rowOf: body(
        ["idx"],
        { required: [I], optional: [], returns: I },
        c("floor", c("div", v("idx"), 8)),
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("colOf: idx % 8 preserves integer", () => {
    const mod = {
      $types: types,
      colOf: body(["idx"], { required: [I], optional: [], returns: I }, c("mod", v("idx"), 8)),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("toIdx: row * 8 + col preserves integer through mul/add", () => {
    const mod = {
      $types: types,
      toIdx: body(
        ["row", "col"],
        { required: [I, I], optional: [], returns: I },
        c("add", c("mul", v("row"), 8), v("col")),
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("inBounds: a variadic $and of comparisons is boolean", () => {
    const mod = {
      $types: types,
      inBounds: body(
        ["row", "col"],
        { required: [I, I], optional: [], returns: B },
        {
          $and: [
            c("gte", v("row"), 0),
            c("lte", v("row"), 7),
            c("gte", v("col"), 0),
            c("lte", v("col"), 7),
          ],
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("otherColor: an if over string literals fits the Color enum", () => {
    const mod = {
      $types: types,
      otherColor: body(
        ["color"],
        { required: [Color], optional: [], returns: Color },
        { $if: c("eq", v("color"), "w"), $then: "b", $else: "w" },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("the whole coordinate layer checks together, cleanly", () => {
    const mod = {
      $types: types,
      rowOf: body(
        ["idx"],
        { required: [I], optional: [], returns: I },
        c("floor", c("div", v("idx"), 8)),
      ),
      colOf: body(["idx"], { required: [I], optional: [], returns: I }, c("mod", v("idx"), 8)),
      toIdx: body(
        ["row", "col"],
        { required: [I, I], optional: [], returns: I },
        c("add", c("mul", v("row"), 8), v("col")),
      ),
      inBounds: body(
        ["row", "col"],
        { required: [I, I], optional: [], returns: B },
        {
          $and: [
            c("gte", v("row"), 0),
            c("lte", v("row"), 7),
            c("gte", v("col"), 0),
            c("lte", v("col"), 7),
          ],
        },
      ),
      otherColor: body(
        ["color"],
        { required: [Color], optional: [], returns: Color },
        { $if: c("eq", v("color"), "w"), $then: "b", $else: "w" },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — nullability and the narrowing wall (§5.5).
//
// The chess piece layer works over `Cell = Piece | null`. The idiom is
// guard-then-use: `if isNull(piece) then ... else <use piece as a string>`.
// The `else` branch is only reached when `piece` is non-null, but the checker
// performs *no flow narrowing* yet — so `piece` keeps its declared `Cell` type
// inside the branch and a `string`-expecting builtin sees `Piece | null`.
//
// Milestone 1 (§5.5 option 2) now does *real* flow narrowing for the tractable
// case — the guarded subject is a bare `$var` (param or eager local) and the
// fact holds within one `$if`/`$cond`/`$match` arm. So `pieceColor`'s
// `isNull(piece)` guard narrows `piece` from `Cell` to `Piece` in the
// else-branch, and `upper(piece)` type-checks clean. Cases narrowing *can't*
// reach (a builtin-result precision loss like `makePiece`) are now hard errors
// too (§4.5 removed the warning downgrade) — discharge them with a guard or an
// `x!` assertion.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 2: nullability & narrowing", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const v = (name: string): JSONType => ({ $var: name });
  const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  const Color: Schema = { $ref: "#/$defs/Color" };
  const Cell: Schema = { $ref: "#/$defs/Cell" };
  const Piece: Schema = { $ref: "#/$defs/Piece" };
  const PieceType: Schema = { $ref: "#/$defs/PieceType" };
  const ColorOrNull: Schema = { anyOf: [Color, { type: "null" }] };

  const types: Defs = {
    Color: { enum: ["w", "b"] },
    Piece: { enum: ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] },
    PieceType: { enum: ["P", "N", "B", "R", "Q", "K"] },
    Cell: { anyOf: [{ $ref: "#/$defs/Piece" }, { type: "null" }] },
  };

  test("isNull accepts a Cell and yields boolean (the guard itself is fine)", () => {
    const mod = {
      $types: types,
      isEmpty: body(
        ["piece"],
        { required: [Cell], optional: [], returns: { type: "boolean" } },
        c("isNull", v("piece")),
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("pieceColor: isNull(piece) narrows Cell to Piece in the else-branch (§5.5 M1)", () => {
    // (piece: Cell) => if isNull(piece) then null
    //                  else if piece == upper(piece) then "w" else "b"
    const mod = {
      $types: types,
      pieceColor: body(
        ["piece"],
        { required: [Cell], optional: [], returns: ColorOrNull },
        {
          $if: c("isNull", v("piece")),
          $then: null,
          $else: {
            $if: c("eq", v("piece"), c("upper", v("piece"))),
            $then: "w",
            $else: "b",
          },
        },
      ),
    };
    // The `isNull` guard proves `piece : Piece` on the else-branch, so
    // `upper(piece)` (Piece ⊆ string) type-checks clean — zero diagnostics.
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test('negative narrowing: eq(color, "w") excludes the literal on the else-branch', () => {
    // (color: Color) => if color == "w" then "first" else <use narrowed color>
    // On the else-branch `color` is narrowed to the `Color` enum minus "w",
    // i.e. the const "b", which still fits the declared `Color` return.
    const mod = {
      $types: types,
      afterWhite: body(
        ["color"],
        { required: [Color], optional: [], returns: Color },
        { $if: c("eq", v("color"), "w"), $then: "b", $else: v("color") },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("narrowed var feeds a field projection: isNull(sq) guard unlocks sq.file", () => {
    // (sq: Square | null) => if isNull(sq) then 0 else sq.file
    // Without narrowing, the else-branch target is `Square | null` (a union, not
    // an object), so `$get "file"` degrades to `any` and `any ⊄ integer` fires.
    // The `isNull` guard narrows `sq` to `Square`, so the projection yields the
    // declared `file : integer` and the module is clean — an observable proof
    // that narrowing feeds `$get`.
    const Square: Schema = {
      type: "object",
      properties: { file: I, rank: I },
      required: ["file", "rank"],
      additionalProperties: false,
    };
    const NullableSquare: Schema = { anyOf: [Square, { type: "null" }] };
    const mod = {
      $types: types,
      fileOf: body(
        ["sq"],
        { required: [NullableSquare], optional: [], returns: I },
        {
          $if: c("isNull", v("sq")),
          $then: 0,
          $else: { $get: "file", $from: v("sq") },
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("makePiece: lower(type) widens the enum to `string`, losing ⊆ Piece (§5.3 precision)", () => {
    // (color: Color, type: PieceType) => if color == "w" then type else lower(type)
    // The argument `lower(type)` type-checks (PieceType ⊆ string), but `lower`'s
    // result schema is the generic `string`, so the `if` union
    // `PieceType | string` no longer fits the declared `Piece` return. This is a
    // *builtin result precision* limit, distinct from the narrowing wall above.
    // §4.5 removed the overlapping-mismatch "warning" downgrade, so this is now
    // a hard error (discharge it with a guard or an `x!` assertion).
    const mod = {
      $types: types,
      makePiece: body(
        ["color", "type"],
        { required: [Color, PieceType], optional: [], returns: Piece },
        {
          $if: c("eq", v("color"), "w"),
          $then: v("type"),
          $else: c("lower", v("type")),
        },
      ),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    // Check-mode pushes `Piece` into each arm, so the mismatch pinpoints the
    // offending `$else` (the `lower(type)` result), not the whole `$return`.
    expect(diags[0]!.path).toEqual(["makePiece", "$return", "$else"]);
    expect(eqJson(diags[0]!.expected, Piece)).toBe(true);
  });

  test("a disjoint mismatch stays a hard error (the predicate discriminates)", () => {
    // Return an `integer` (length's result) where a `Color` enum is declared. No
    // arm of `integer` fits `Color`, so the types are disjoint and this is a
    // genuine error, not a runtime-checkable warning.
    const mod = {
      $types: types,
      bad: body(["color"], { required: [Color], optional: [], returns: Color }, c("length", "abc")),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["bad", "$return"]);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — lazy-local narrowing at forcing sites (§5.5 M2).
//
// The bulk of real chess narrows a value that flows *through* a where-local,
// not the guarded var directly:
//   * `pieceMoves`: `type`/`color` are lazy locals bound from `piece`; they are
//     forced only inside the non-null (`else`) arm, so re-synthesizing them
//     under the guard's fact is sound and clean.
//   * `slideDir`: the arms of a `$cond` are guarded by *named boolean locals*
//     (`empty: isNull(target)`, `ok: not(empty)`), not inline predicates.
//
// M2 threads the forcing site's facts into lazy-local resolution behind a
// free-variable gate (the no-narrowing path is byte-identical), re-synthesizes
// a dependent local under the *relevant* facts with a fact-keyed cache, and
// teaches `factsFromCondition` to recurse through a boolean-guard local.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 3: lazy-local & boolean-guard narrowing (§5.5 M2)", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const v = (name: string): JSONType => ({ $var: name });

  const Cell: Schema = { $ref: "#/$defs/Cell" };
  const StringOrNull: Schema = { anyOf: [S, { type: "null" }] };
  const StringArray: Schema = { type: "array", items: S };

  const types: Defs = {
    Color: { enum: ["w", "b"] },
    Piece: { enum: ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] },
    Cell: { anyOf: [{ $ref: "#/$defs/Piece" }, { type: "null" }] },
  };

  test("pieceMoves: locals bound from a guarded var narrow at their forcing site", () => {
    // (piece: Cell) => if isNull(piece) then [] else [type, color]
    //   where type = upper(piece), color = lower(piece)
    // `type`/`color` reference `piece` but are forced *only* in the non-null
    // else-arm. Under M1 they were synthesized once, un-narrowed, so
    // `upper(Cell)` warned (Cell ⊄ string). M2 re-synthesizes them under the
    // guard's `piece : Piece` fact (indirect narrowing through the free-var
    // gate), so both fit `string` and the module is clean.
    const mod = {
      $types: types,
      pieceMoves: body(
        ["piece"],
        { required: [Cell], optional: [], returns: StringArray },
        { $if: c("isNull", v("piece")), $then: [], $else: [v("type"), v("color")] },
        { type: c("upper", v("piece")), color: c("lower", v("piece")) },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("slideDir: a $cond guarded by named boolean locals narrows the else-arm (§2.3)", () => {
    // (target: Cell) => cond { !ok -> null, empty -> null, else -> upper(target) }
    //   where empty = isNull(target), ok = not(empty)   // alias depth 2
    // The else-arm is reached only when every guard is false, which the boolean
    // aliases prove implies `target : Piece`. `factsFromCondition` recurses
    // through `ok -> not(empty) -> isNull(target)` to learn that, so
    // `upper(target)` type-checks clean.
    const mod = {
      $types: types,
      slideDir: body(
        ["target"],
        { required: [Cell], optional: [], returns: StringOrNull },
        {
          $cond: [
            [c("not", v("ok")), null],
            [v("empty"), null],
          ],
          $else: c("upper", v("target")),
        },
        { empty: c("isNull", v("target")), ok: c("not", v("empty")) },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("bare where-local condition falls back to truthiness when its initializer is not a guard", () => {
    // (x: string | null) => if h then h else ""
    //   where h = maybe(x), maybe: (string | null) -> string | null
    // The local initializer is a typed call, not a recognized guard, so
    // `factsFromCondition(h)` must fall back to the truthiness of `h` itself.
    const mod = {
      $types: types,
      localTruthy: body(
        ["x"],
        { required: [StringOrNull], optional: [], returns: S },
        { $if: v("h"), $then: v("h"), $else: "" },
        {
          h: c("maybe", v("x")),
          maybe: body(
            ["y"],
            { required: [StringOrNull], optional: [], returns: StringOrNull },
            v("y"),
          ),
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("parseMove: !isNull(from) && !isNull(to) narrows both before object construction", () => {
    // (from: Cell, to: Cell) => if !isNull(from) && !isNull(to)
    //                           then { from, to } else null
    // The conjunction narrows both vars to `Piece` on the then-arm, so the
    // constructed object fits the non-null `Move` shape.
    const Move: Schema = {
      type: "object",
      properties: { from: { $ref: "#/$defs/Piece" }, to: { $ref: "#/$defs/Piece" } },
      required: ["from", "to"],
      additionalProperties: false,
    };
    const mod = {
      $types: types,
      parseMove: body(
        ["from", "to"],
        { required: [Cell, Cell], optional: [], returns: { anyOf: [Move, { type: "null" }] } },
        {
          $if: { $and: [c("not", c("isNull", v("from"))), c("not", c("isNull", v("to")))] },
          $then: { from: v("from"), to: v("to") },
          $else: null,
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("per-arm divergence: a local re-synthesizes per fact set, with dedup'd diagnostics", () => {
    // (p: Color, q: Cell) => match p { "w" -> d } else d
    //   where d = [upper(q), p]
    // `d` is forced under two distinct facts — p : "w" (case) and p : "b"
    // (else). The memo split gives `d` two element types ("w" vs "b"), whose
    // union no longer fits the declared `[string, "w"]` return → one return
    // error (absent if the two arms had collapsed onto one memo). Meanwhile
    // `upper(q)` (q never narrowed) errors inside *each* re-synth of `d`, but the
    // two are structurally identical, so the end-of-module dedupe keeps one.
    const Color: Schema = { $ref: "#/$defs/Color" };
    const mod = {
      $types: types,
      divergent: body(
        ["p", "q"],
        {
          required: [Color, Cell],
          optional: [],
          returns: { type: "array", prefixItems: [S, { const: "w" }], items: false, minItems: 2 },
        },
        { $match: v("p"), $cases: [["w", v("d")]], $else: v("d") },
        { d: [c("upper", v("q")), v("p")] },
      ),
    };
    const diags = checkModule(mod, BT);
    // Exactly two: 1 (not 3) means the duplicate `upper(q)` error was deduped;
    // 2 (not 1) means the else-arm re-synthesized `d` under its own fact.
    expect(diags.length).toBe(2);
    expect(diags.every((d) => d.severity === "error")).toBe(true);
    // Check-mode pushes the tuple return into each arm, so the return mismatch
    // pinpoints the diverging `$else` arm rather than the whole `$return`.
    expect(diags.some((d) => d.path.join(".") === "divergent.$return.$in.$else")).toBe(true);
    expect(diags.some((d) => d.path.join(".") === "divergent.$return.$let.d.[0].$args[0]")).toBe(
      true,
    );
  });

  test("fast path: a module with no narrowing is unaffected by the gate/dedupe", () => {
    // A plain guard-free use: `upper(q)` on a `Cell` errors (Cell ⊄ string).
    // No narrowing is in play, so the free-var gate returns the un-narrowed memo
    // and the dedupe is a no-op — the diagnostic is exactly the single mismatch
    // error, unchanged.
    const mod = {
      $types: types,
      plain: body(["q"], { required: [Cell], optional: [], returns: S }, c("upper", v("q"))),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["plain", "$return", "$args[0]"]);
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — field-path & discriminant narrowing (§5.5 M3).
//
// M1/M2 narrow a bare `$var`. M3 extends narrowing to subjects that are
// *paths* — a field/element reached *through* a value:
//   * Nullable field: `isNull(move.from)` then `move.from` used as a `Piece`.
//     The guard subject is the path `move.from`, keyed as such on
//     `ctx.narrowings` and read back at the `$get` projection site.
//   * Discriminated union: `s.tag == "circle"` narrows `s` to the union arm
//     whose `tag` is `const "circle"`, so `s.r`/`s.side` project cleanly.
// The M2 re-synth machinery (free-var gate, fact-keyed cache) is reused: a lazy
// local that reaches through a narrowed path re-synthesizes under the path fact.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 4: field-path & discriminant narrowing (§5.5 M3)", () => {
  const BT = loadBuiltinTable();
  const c = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const v = (name: string): JSONType => ({ $var: name });
  const g = (key: JSONType, from: JSONType): JSONType => ({ $get: key, $from: from });

  const Piece: Schema = { $ref: "#/$defs/Piece" };
  const Cell: Schema = { $ref: "#/$defs/Cell" };
  const StringOrNull: Schema = { anyOf: [S, { type: "null" }] };
  const PieceOrNull: Schema = { anyOf: [Piece, { type: "null" }] };

  // A move whose endpoints are *nullable* piece cells (the M3 field-path case:
  // the guarded thing is `move.from`, not `move`).
  const Move: Schema = {
    type: "object",
    properties: { from: Cell, to: Cell },
    required: ["from", "to"],
    additionalProperties: false,
  };

  const types: Defs = {
    Piece: { enum: ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"] },
    Cell: { anyOf: [{ $ref: "#/$defs/Piece" }, { type: "null" }] },
  };

  test("nullable field: isNull(move.from) narrows the path move.from to Piece in the else-arm", () => {
    // (move: Move) => if isNull(move.from) then null else upper(move.from)
    // Without path narrowing, `move.from : Cell` (Piece | null), `upper` wants
    // string → a hard error. M3 narrows the *path* `move.from` to `Piece` on the
    // else-arm, so `upper(move.from)` type-checks clean.
    const mod = {
      $types: types,
      firstGlyph: body(
        ["move"],
        { required: [Move], optional: [], returns: StringOrNull },
        {
          $if: c("isNull", g("from", v("move"))),
          $then: null,
          $else: c("upper", g("from", v("move"))),
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("discriminated union: s.tag == lit narrows s to the matching arm", () => {
    // (s: Shape) => if s.tag == "circle" then s.r else s.side
    // Without narrowing, `s` is the full union in both arms, so `s.r`/`s.side`
    // project to `any` (union isn't an object) and `any ⊄ integer` is a hard
    // error. M3 narrows `s` to the arm whose `tag` const matches, so each
    // projection yields the declared `integer`.
    const Circle: Schema = {
      type: "object",
      properties: { tag: { const: "circle" }, r: I },
      required: ["tag", "r"],
      additionalProperties: false,
    };
    const Square: Schema = {
      type: "object",
      properties: { tag: { const: "square" }, side: I },
      required: ["tag", "side"],
      additionalProperties: false,
    };
    const shapeTypes: Defs = { Shape: { anyOf: [Circle, Square] } };
    const Shape: Schema = { $ref: "#/$defs/Shape" };
    const mod = {
      $types: shapeTypes,
      area: body(
        ["s"],
        { required: [Shape], optional: [], returns: I },
        {
          $if: c("eq", g("tag", v("s")), "circle"),
          $then: g("r", v("s")),
          $else: g("side", v("s")),
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("disjoint field use stays a hard error even after path narrowing", () => {
    // Narrow `move.from` to `Piece`, then feed it where an integer is wanted.
    // `Piece` is disjoint from `integer`, so this must remain a hard error —
    // path narrowing must not silence a genuine mismatch.
    const mod = {
      $types: types,
      needInt: body(["n"], { required: [I], optional: [], returns: I }, v("n")),
      badField: body(
        ["move"],
        { required: [Move], optional: [], returns: I },
        {
          $if: c("not", c("isNull", g("from", v("move")))),
          $then: c("needInt", g("from", v("move"))),
          $else: 0,
        },
      ),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["badField", "$return", "$then", "$args[0]"]);
  });

  test("lazy local through a path: a where-local bound from move.from narrows at forcing", () => {
    // (move: Move) => if isNull(move.from) then null else glyph
    //   where glyph = upper(move.from)
    // `glyph` reaches through the narrowed path `move.from` but is forced only
    // in the non-null else-arm. The M2 re-synth engine (free-var gate widened to
    // record path keys) re-types it under the `move.from : Piece` fact → clean.
    const mod = {
      $types: types,
      firstGlyphLocal: body(
        ["move"],
        { required: [Move], optional: [], returns: StringOrNull },
        {
          $if: c("isNull", g("from", v("move"))),
          $then: null,
          $else: v("glyph"),
        },
        { glyph: c("upper", g("from", v("move"))) },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("negated field guard narrows to non-null on the then-arm", () => {
    // (move: Move) => if !isNull(move.to) then move.to else null
    // The truthy branch of `!isNull(move.to)` proves `move.to : Piece`.
    const mod = {
      $types: types,
      target: body(
        ["move"],
        { required: [Move], optional: [], returns: PieceOrNull },
        {
          $if: c("not", c("isNull", g("to", v("move")))),
          $then: g("to", v("move")),
          $else: null,
        },
      ),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 5 — $match exhaustiveness & dead-case lints (§5.6).
//
// The exhaustiveness lint reuses the residual that narrowing already computes:
// if a `$match` subject has a *finite* set of possible values (an enum var, a
// union of consts, or a `base.field` discriminant across union arms) and the
// cases don't cover all of them with no catch-all `$else`, some input silently
// falls through — a hard `error` (§4.5), not a warning. Conversely a case whose
// literal can never occur in the subject's universe is dead code — a separate
// `error`.
// ---------------------------------------------------------------------------

describe("chess fragments — Tier 5: $match exhaustiveness & dead cases (§5.6)", () => {
  const BT = loadBuiltinTable();
  const v = (name: string): JSONType => ({ $var: name });
  const g = (key: JSONType, from: JSONType): JSONType => ({ $get: key, $from: from });

  const Color: Schema = { $ref: "#/$defs/Color" };
  const types: Defs = { Color: { enum: ["w", "b"] } };

  // A discriminated union: two object arms distinguished by a `tag` const.
  const Circle: Schema = {
    type: "object",
    properties: { tag: { const: "circle" }, r: I },
    required: ["tag", "r"],
    additionalProperties: false,
  };
  const Square: Schema = {
    type: "object",
    properties: { tag: { const: "square" }, side: I },
    required: ["tag", "side"],
    additionalProperties: false,
  };
  const shapeTypes: Defs = { Shape: { anyOf: [Circle, Square] } };
  const Shape: Schema = { $ref: "#/$defs/Shape" };

  test("enum match missing an arm errors (no $else, unhandled 'b')", () => {
    // (color: Color) => match color { "w" -> 1 }   // no "b", no $else
    const mod = {
      $types: types,
      f: body(["color"], { required: [Color], optional: [], returns: I }, {
        $match: v("color"),
        $cases: [["w", 1]],
      } as JSONType),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return"]);
    expect(/unhandled case\(s\) "b"/.test(diags[0]!.message)).toBe(true);
  });

  test("a full enum match is clean even without an $else", () => {
    // (color: Color) => match color { "w" -> 1, "b" -> 2 }   // covers all
    const mod = {
      $types: types,
      f: body(["color"], { required: [Color], optional: [], returns: I }, {
        $match: v("color"),
        $cases: [
          ["w", 1],
          ["b", 2],
        ],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("a present $else suppresses the exhaustiveness error", () => {
    // (color: Color) => match color { "w" -> 1 } else 2
    const mod = {
      $types: types,
      f: body(["color"], { required: [Color], optional: [], returns: I }, {
        $match: v("color"),
        $cases: [["w", 1]],
        $else: 2,
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("discriminated-union match missing an arm errors (unhandled 'square')", () => {
    // (s: Shape) => match s.tag { "circle" -> 1 }   // missing "square", no $else
    const mod = {
      $types: shapeTypes,
      f: body(["s"], { required: [Shape], optional: [], returns: I }, {
        $match: g("tag", v("s")),
        $cases: [["circle", 1]],
      } as JSONType),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(/unhandled case\(s\) "square"/.test(diags[0]!.message)).toBe(true);
  });

  test("a full discriminated-union match is clean without an $else", () => {
    // (s: Shape) => match s.tag { "circle" -> 1, "square" -> 2 }
    const mod = {
      $types: shapeTypes,
      f: body(["s"], { required: [Shape], optional: [], returns: I }, {
        $match: g("tag", v("s")),
        $cases: [
          ["circle", 1],
          ["square", 2],
        ],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("discriminated-union match narrows the base in each case arm", () => {
    // (s: Shape) => match s.tag { "circle" -> s.r, "square" -> s.side }
    // Each arm can project the field unique to the matched object variant.
    const mod = {
      $types: shapeTypes,
      f: body(["s"], { required: [Shape], optional: [], returns: I }, {
        $match: g("tag", v("s")),
        $cases: [
          ["circle", g("r", v("s"))],
          ["square", g("side", v("s"))],
        ],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });

  test("a dead/impossible case errors (literal not in the enum)", () => {
    // (color: Color) => match color { "w" -> 1, "x" -> 2 } else 3
    // "x" is not a Color, so that case can never match.
    const mod = {
      $types: types,
      f: body(["color"], { required: [Color], optional: [], returns: I }, {
        $match: v("color"),
        $cases: [
          ["w", 1],
          ["x", 2],
        ],
        $else: 3,
      } as JSONType),
    };
    const diags = checkModule(mod, BT);
    expect(diags.length).toBe(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.path).toEqual(["f", "$return", "$cases[1][0]"]);
    expect(/Unreachable \$match case/.test(diags[0]!.message)).toBe(true);
  });

  test("a match over an infinite subject is not linted (undecidable universe)", () => {
    // (s: string) => match s { "hi" -> 1 }   // string is not finite → no lint
    const mod = {
      f: body(["s"], { required: [S], optional: [], returns: I }, {
        $match: v("s"),
        $cases: [["hi", 1]],
      } as JSONType),
    };
    expect(checkModule(mod, BT)).toEqual([]);
  });
});
