# Shorthand Walkthrough: `chess.jsonc`

Working notes translating real pieces of [`examples/chess.jsonc`](../examples/chess.jsonc)
into the proposed shorthand ([`docs/shorthand.md`](./shorthand.md)). Each piece
shows the transformation and records **problems, uncertainties, and design
weaknesses** we surface along the way. This is design feedback, not a finished
spec.

Legend: 🟢 works cleanly · 🟡 works but worth noting · 🔴 problem / open question.

---

## Piece 1 — A simple function + the top-level shape

Source ([`examples/chess.jsonc`](../examples/chess.jsonc)):

```26:37:examples/chess.jsonc
  "pieceColor": {
    "$params": ["piece"],
    "$return": {
      "$if": { "$fn": ["isNull", { "$var": "piece" }] },
      "$then": null,
      "$else": {
        "$if": { "$eq": [{ "$var": "piece" }, { "$fn": ["upper", { "$var": "piece" }] }] },
        "$then": "w",
        "$else": "b",
      },
    },
  },
```

Shorthand:

```jfn
// pieceColor(piece) → null | "w" | "b"
pieceColor: (piece) =>
  if isNull(piece)
    then null
    else if piece == upper(piece) then "w" else "b",
```

### Transformation

- The **whole file is a plain data object** mapping names → function bodies (the
  registry). So each definition is a `name: <function literal>` entry (colon =
  data-object entry). `pieceColor(...)` calls elsewhere resolve against these
  keys as literal name strings.
- `{"$params":["piece"], "$return": ...}` → `(piece) => <return expr>`.
- Nested `$if` → chained `if … then … else if … then … else …`.
- `{"$fn":["isNull", …]}` → `isNull(piece)`; `$eq` → `==`.

### Notes

- 🟡 **Comment attachment.** The `//` doc-comment lowers to a `$comment` sibling
  *inside the `pieceColor` function body*. That round-trips (unlike JSONC), but
  note the comment semantically describes the entry, and it physically lands on
  the body value — fine here, but see Piece 8 for where this gets lossy.
- 🟢 Deep `if/else` chains read well and stay unambiguous (no dangling-else
  problem because `else` is mandatory and every branch is an expression).

---

## Piece 2 — Lazy locals, recursion, `$cond`

Source:

```100:128:examples/chess.jsonc
  "slideDir": {
    "$params": ["board", "row", "col", "dr", "dc", "color"],
    "nr": { "$fn": ["add", { "$var": "row" }, { "$var": "dr" }] },
    "nc": { "$fn": ["add", { "$var": "col" }, { "$var": "dc" }] },
    "ok": { "$fn": ["inBounds", { "$var": "nr" }, { "$var": "nc" }] },
    "tIdx": { "$fn": ["toIdx", { "$var": "nr" }, { "$var": "nc" }] },
    "target": { "$var": "board", "$get": { "$var": "tIdx" } },
    "empty": { "$fn": ["isNull", { "$var": "target" }] },
    "ally": { "$eq": [{ "$fn": ["pieceColor", { "$var": "target" }] }, { "$var": "color" }] },
    "rest": {
      "$fn": [
        "slideDir",
        { "$var": "board" },
        { "$var": "nr" },
        { "$var": "nc" },
        { "$var": "dr" },
        { "$var": "dc" },
        { "$var": "color" },
      ],
    },
    "$return": {
      "$cond": [
        [{ "$not": { "$var": "ok" } }, []],
        [{ "$var": "empty" }, { "$fn": ["concat", [{ "$var": "tIdx" }], { "$var": "rest" }] }],
        [{ "$var": "ally" }, []],
      ],
      "$else": [{ "$var": "tIdx" }],
    },
  },
```

Shorthand:

```jfn
slideDir: (board, row, col, dr, dc, color) => {
  nr     = add(row, dr),
  nc     = add(col, dc),
  ok     = inBounds(nr, nc),
  tIdx   = toIdx(nr, nc),
  target = board[tIdx],
  empty  = isNull(target),
  ally   = pieceColor(target) == color,
  rest   = slideDir(board, nr, nc, dr, dc, color),
  return cond {
    !ok   => [],
    empty => concat([tIdx], rest),
    ally  => [],
    else  => [tIdx]
  }
}
```

### Transformation

- Lazy locals → `=` bindings; `$return` → `return`. `board[tIdx]` (variable base,
  variable key) → computed `$get`. `$cond`/`$else` → `cond { … else => … }`.
- Recursion by registered name is just `slideDir(...)`.

### Notes

- 🔴 **Laziness is invisible and load-bearing.** `rest` recurses unconditionally
  *as written*, but it's a lazy local only forced in the `empty` branch. If a
  reader (or a naive re-implementation of the shorthand) treats the `{ … }` block
  as imperative/eager, this infinite-loops. The block form reads exactly like
  eager sequential code. We need either (a) a strong doc convention, or (b) a
  more obviously-lazy syntax (e.g. `let`-less bindings, or a visual cue). This is
  the single biggest semantic-fidelity risk in the block syntax.
- 🔴 **Arm arrow vs. function arrow collide.** Both `cond` arms and function
  literals use `=>`. Here it's benign, but `pattern => { … }` (an arm whose
  result is an object) is genuinely ambiguous against `(params) => { … }` (a
  block). **Recommendation:** give arms a distinct token — e.g. `cond { !ok -> [] }`
  — reserving `=>` for function literals. Revisit before finalizing §6 of the
  spec.
- 🟢 Empty-array results `[]` and `concat([tIdx], rest)` are unremarkable.

---

## Piece 3 — HOF callback + the `$get`/path ambiguity

Source:

```132:156:examples/chess.jsonc
  "slideMoves": {
    "$params": ["board", "idx", "color", "dirs"],
    "row": { "$fn": ["rowOf", { "$var": "idx" }] },
    "col": { "$fn": ["colOf", { "$var": "idx" }] },
    "$return": {
      "$fn": [
        "flatMap",
        {
          "$params": ["d"],
          "$return": {
            "$fn": [
              "slideDir",
              { "$var": "board" },
              { "$var": "row" },
              { "$var": "col" },
              { "$var": "d", "$get": 0 },
              { "$var": "d", "$get": 1 },
              { "$var": "color" },
            ],
          },
        },
        { "$var": "dirs" },
      ],
    },
  },
```

Shorthand:

```jfn
slideMoves: (board, idx, color, dirs) => {
  row = rowOf(idx),
  col = colOf(idx),
  return flatMap(
    (d) => slideDir(board, row, col, d[0], d[1], color),
    dirs
  )
}
```

### Transformation

- Inline anonymous callback → a function literal `(d) => …` passed as the first
  arg (callback-first ordering is visible and natural).
- Single-expression body → `=>` with no block.

### Notes

- 🔴 **Bijection break: `{"$var":"d","$get":0}` vs `{"$var":"d[0]"}`.** The source
  writes the *literal* index `d[0]` as `$var`+`$get: 0`. Our shorthand `d[0]`
  canonically lowers to the **path-string** form `{"$var":"d[0]"}`. Both JSON
  forms are semantically identical, so there are **two JSON spellings for one
  shorthand** — meaning shorthand→JSON→shorthand is fine, but JSON→shorthand→JSON
  *normalizes* `chess.jsonc` (rewrites `$get: 0` into `d[0]`). We must decide:
  - **(a)** Declare a single canonical JSON form for static scalar access
    (probably the path string) and accept that pretty-printing existing files
    normalizes them. Cleanest, but the bijection is JSON*(canonical)*↔shorthand,
    not JSON*(any)*↔shorthand.
  - **(b)** Distinguish in surface syntax (e.g. `d.[0]` for `$get`, `d[0]` for
    path) — ugly and low-value.
  - I lean strongly toward **(a)**; we just need to state the canonicalization
    rule explicitly and provide a `normalize` pass so users aren't surprised.
- 🟡 A literal index inside `[...]` (`d[0]`) is a static path segment, while a
  *variable* index (`d[i]`) would be computed `$get`. The two look nearly
  identical in source — worth calling out in docs so authors aren't surprised
  which one they get.

---

## Piece 4 — Nested closure with locals + `raw` data table

Source (abridged):

```228:272:examples/chess.jsonc
  "knightMoves": {
    "$params": ["board", "idx", "color"],
    "row": { "$fn": ["rowOf", { "$var": "idx" }] },
    "col": { "$fn": ["colOf", { "$var": "idx" }] },
    "$return": {
      "$fn": [
        "flatMap",
        {
          "$params": ["off"],
          "r": { "$fn": ["add", { "$var": "row" }, { "$var": "off", "$get": 0 }] },
          "c": { "$fn": ["add", { "$var": "col" }, { "$var": "off", "$get": 1 }] },
          "ok": { "$fn": ["inBounds", { "$var": "r" }, { "$var": "c" }] },
          "tIdx": { "$fn": ["toIdx", { "$var": "r" }, { "$var": "c" }] },
          "target": {
            "$if": { "$var": "ok" },
            "$then": { "$var": "board", "$get": { "$var": "tIdx" } },
            "$else": null,
          },
          "blocked": {
            "$if": { "$fn": ["isNull", { "$var": "target" }] },
            "$then": false,
            "$else": {
              "$eq": [{ "$fn": ["pieceColor", { "$var": "target" }] }, { "$var": "color" }],
            },
          },
          "$return": {
            "$if": { "$and": [{ "$var": "ok" }, { "$not": { "$var": "blocked" } }] },
            "$then": [{ "$var": "tIdx" }],
            "$else": [],
          },
        },
        {
          "$literal": [
            [-2, -1],
            [-2, 1],
            [-1, -2],
            [-1, 2],
            [1, -2],
            [1, 2],
            [2, -1],
            [2, 1],
          ],
        },
      ],
    },
  },
```

Shorthand:

```jfn
knightMoves: (board, idx, color) => {
  row = rowOf(idx),
  col = colOf(idx),
  return flatMap(
    (off) => {
      r       = add(row, off[0]),
      c       = add(col, off[1]),
      ok      = inBounds(r, c),
      tIdx    = toIdx(r, c),
      target  = if ok then board[tIdx] else null,
      blocked = if isNull(target) then false else pieceColor(target) == color,
      return if ok && !blocked then [tIdx] else []
    },
    raw [[-2,-1], [-2,1], [-1,-2], [-1,2], [1,-2], [1,2], [2,-1], [2,1]]
  )
}
```

### Transformation

- The callback is a full function literal *with its own lazy locals* — a closure
  capturing `board`, `row`, `col`, `color`. No special closure syntax needed.
- `$literal` offset table → `raw [...]`. Self-delimiting, so it works fine in
  argument position.
- `$and` of two operands → `ok && !blocked`.

### Notes

- 🟢 **`raw` earns its keep here.** The offsets are constant data walked on every
  call; `$literal`/`raw` is exactly the "inert, hot-path constant" case, and it
  reads clearly distinct from an evaluated `[...]`.
- 🟡 **Why `raw` and not plain `[...]`?** A plain `[[-2,-1], …]` array would *also*
  evaluate to the same value (its elements are number literals), so semantically
  `raw` is optional here. Authors need guidance on when `raw` is required
  (data containing `$`-keys, or avoiding re-evaluation cost) vs. merely
  stylistic. Risk: LLMs sprinkle `raw` inconsistently, hurting the bijection's
  "one shorthand per JSON" goal — a plain array and a `raw` array are *different*
  JSON (`[...]` vs `{"$literal": [...]}`). The canonicalizer can't collapse them
  because they mean different things to the interpreter, so this stays author-controlled.
- 🟢 Deeply nested inline function bodies stay readable, and indentation carries
  the closure nesting better than the JSON does.

---

## Piece 5 — `raw` object + computed access + string escapes

Source:

```963:976:examples/chess.jsonc
  "pieceGlyph": {
    "$params": ["piece"],
    "PIECES": {
      "$literal": {
        "K": "\u2654", "Q": "\u2655", "R": "\u2656", "B": "\u2657", "N": "\u2658", "P": "\u2659",
        "k": "\u265A", "q": "\u265B", "r": "\u265C", "b": "\u265D", "n": "\u265E", "p": "\u265F",
      },
    },
    "$return": {
      "$if": { "$fn": ["isNull", { "$var": "piece" }] },
      "$then": "\u00b7",
      "$else": { "$var": "PIECES", "$get": { "$var": "piece" } },
    },
  },
```

Shorthand:

```jfn
pieceGlyph: (piece) => {
  PIECES = raw {
    "K": "\u2654", "Q": "\u2655", "R": "\u2656", "B": "\u2657", "N": "\u2658", "P": "\u2659",
    "k": "\u265A", "q": "\u265B", "r": "\u265C", "b": "\u265D", "n": "\u265E", "p": "\u265F"
  },
  return if isNull(piece) then "\u00b7" else PIECES[piece]
}
```

### Transformation

- `$literal` object → `raw { … }`. Because it's a `raw` island the keys stay
  literal data (no `$`-collision concern), and JSON string escapes (`\u2654`)
  pass through unchanged.
- `PIECES[piece]` — local variable base, variable key → computed `$get`.

### Notes

- 🟢 This is the clean case for the **`raw` object**: a constant lookup table. The
  computed access `PIECES[piece]` right after it shows the expression/data
  boundary crossing exactly once and reads well.
- 🟡 **`raw` body grammar.** Inside `raw { … }` we're parsing *JSON*, not
  shorthand — so keys must be quoted and there are no shorthand niceties. We
  should decide whether the `raw` body is strict JSON or "shorthand-data" (bare
  keys allowed, trailing commas, etc.). Strict JSON is simplest and matches the
  "verbatim island" mental model; I lean that way, but it means a visible mode
  switch mid-file.
- 🔴 **Would a plain `{ … }` object have worked?** No — a plain object's *values*
  are evaluated and a plain object **strips `$comment`** (and would choke if any
  key were a `$`-form). For a pure lookup table of string→string it happens to be
  equivalent, but the author must know that `raw` is the safe default for
  "table I don't want touched." Same consistency risk as Piece 4.

---

## Piece 6 — Dotted paths, `&&`, and returning a data object

Source:

```822:852:examples/chess.jsonc
  "playMove": {
    "$params": ["state", "from", "to"],
    "board": { "$var": "state.board" },
    "turn": { "$var": "state.turn" },
    "status": { "$var": "state.status" },
    "stillPlaying": { "$eq": [{ "$var": "status" }, "playing"] },
    "legal": {
      "$fn": [
        "isLegalMove",
        { "$var": "board" },
        { "$var": "from" },
        { "$var": "to" },
        { "$var": "turn" },
      ],
    },
    "canMove": {
      "$and": [{ "$var": "stillPlaying" }, { "$var": "legal" }],
    },
    "newBoard": { "$fn": ["applyMove", { "$var": "board" }, { "$var": "from" }, { "$var": "to" }] },
    "nextTurn": { "$fn": ["otherColor", { "$var": "turn" }] },
    "newStatus": { "$fn": ["getStatus", { "$var": "newBoard" }, { "$var": "nextTurn" }] },
    "$return": {
      "$if": { "$var": "canMove" },
      "$then": {
        "board": { "$var": "newBoard" },
        "turn": { "$var": "nextTurn" },
        "status": { "$var": "newStatus" },
      },
      "$else": { "$var": "state" },
    },
  },
```

Shorthand:

```jfn
playMove: (state, from, to) => {
  board        = state.board,
  turn         = state.turn,
  status       = state.status,
  stillPlaying = status == "playing",
  legal        = isLegalMove(board, from, to, turn),
  canMove      = stillPlaying && legal,
  newBoard     = applyMove(board, from, to),
  nextTurn     = otherColor(turn),
  newStatus    = getStatus(newBoard, nextTurn),
  return if canMove
    then { board: newBoard, turn: nextTurn, status: newStatus }
    else state
}
```

### Transformation

- `{"$var":"state.board"}` → `state.board` (path DSL lifted verbatim).
- `$and` → `&&`.
- The `$then` value is a **plain data object** → `{ board: …, turn: …, status: … }`.

### Notes

- 🟢 **This validates the `{`-disambiguation rule.** `then { board: … }` uses a
  data object (colon entries), while `=> { board = … }` would be a function
  block (`=` bindings). Because a data object only appears in *expression*
  position (`then`/`else`/arg/binding-RHS/arm-result) and a block only appears
  after a function `=>`, most cases disambiguate purely by context — *except*
  the function-`=>` position itself (see Piece 7).
- 🟡 Bindings-with-`=` vs data-`:` is a subtle visual distinction for an LLM to
  keep straight (`=` inside `=> { … }`, `:` everywhere else). Worth testing
  whether models reliably produce the right one; if not, we may want them to be
  the same token disambiguated purely by position.

---

## Piece 7 — The object-return foot-gun

Source:

```1100:1109:examples/chess.jsonc
  "showResult": {
    "$params": ["state"],
    "$return": {
      "output": { "$fn": ["boardSection", { "$var": "state" }, ""] },
      "stderr": "",
      "newState": null,
      "reset": false,
      "exitCode": 0,
    },
  },
```

Shorthand:

```jfn
showResult: (state) => ({
  output: boardSection(state, ""),
  stderr: "",
  newState: null,
  reset: false,
  exitCode: 0
})
```

### Transformation

- A function whose `$return` is a **data object literal, with no locals**. The
  body is a single expression (the object), so no block is needed…
- …but `(state) => { output: … }` would be parsed as a **function block** (then
  fail, because it has `:` entries and no `return`). So we must parenthesize:
  `=> ({ … })`. This is exactly the classic JavaScript arrow-returns-object
  gotcha.

### Notes

- 🔴 **This is pervasive and the sharpest ergonomic edge.** Every `*Result`
  function (`showResult`, `resetResult`, `helpResult`, and the arms of
  `moveResult`/`handleCommand`) returns a bare object. Requiring `=> ({ … })`
  everywhere is easy to get wrong and easy for an LLM to drop the parens on.
  Options:
  - **(a)** Adopt the JS rule (`=> ({...})`), lean on the fact that models already
    know it. Simple, familiar, but foot-gunny.
  - **(b)** Make `=> { … }` *content-sniff*: colon-entries ⇒ data object,
    `=`/`return` ⇒ block. Removes the parens but makes `{` context-sensitive and
    forbids the (rare) empty/ambiguous cases.
  - **(c)** Give function blocks a distinct opener (e.g. `=> do { … }` or require
    the `return`-less single-expression form to never use braces), freeing `{` to
    always mean data object.
  - My lean: **(b)** if we can prove the grammar stays unambiguous (an object
    never contains top-level `=`, a block always contains `return`), else **(a)**.
    Decide before the spec calls the block form final.
- 🔴 Combined with the **arm-arrow collision** (Piece 2), the two `=>` overloads
  (function literal vs arm) *and* the `{` overload (block vs object) interact.
  `moveResult`'s `$cond` returns objects from arms: `cond { isNull(move) => ({...}) }`.
  Getting arms, blocks, and object-returns mutually unambiguous is the top
  grammar task remaining.

---

## Piece 8 — String building and comment placement

Source (two representative locals from `moveResult`):

```1170:1197:examples/chess.jsonc
    "badParseStderr": {
      "$fn": [
        "strcat",
        "  Invalid move format: \"",
        {
          "$fn": [
            "strcat",
            { "$var": "moveInput" },
            "\". Use algebraic notation like 'e2e4' or 'e2 e4'.",
          ],
        },
      ],
    },
    "gameOverStderr": {
      "$fn": [
        "strcat",
        "  Game is over (",
        { "$fn": ["strcat", { "$var": "status" }, "). Run 'reset' to start a new game."] },
      ],
    },
    "moveDesc": {
      "$fn": [
        "strcat",
        { "$fn": ["squareName", { "$var": "move.from" }] },
        { "$fn": ["strcat", " \u2192 ", { "$fn": ["squareName", { "$var": "move.to" }] }] },
      ],
    },
    "illegalStderr": { "$fn": ["strcat", "  Illegal move: ", { "$var": "moveDesc" }] },
```

Shorthand:

```jfn
// Error strings.
badParseStderr = strcat("  Invalid move format: \"", strcat(moveInput, "\". Use algebraic notation like 'e2e4' or 'e2 e4'.")),
gameOverStderr = strcat("  Game is over (", strcat(status, "). Run 'reset' to start a new game.")),
moveDesc       = strcat(squareName(move.from), strcat(" \u2192 ", squareName(move.to))),
illegalStderr  = strcat("  Illegal move: ", moveDesc),
```

### Transformation

- Nested `strcat` calls stay nested `strcat(…, strcat(…, …))`.
- String literals keep JSON escaping (`\"`, `\u2192`) verbatim.
- `move.from` / `move.to` are dotted paths.

### Notes

- 🔴 **String building is painful.** `strcat` is strictly binary, so every
  multi-part string is a right-leaning nest. This is verbose in JSON *and* in the
  shorthand — we barely helped. This is a strong argument for a shorthand-only
  affordance that lowers to nested `strcat`:
  - a **`++` operator** (`a ++ b ++ c` → `strcat(a, strcat(b, c))`), or
  - **template strings** (`` `  Illegal move: ${moveDesc}` ``), which LLMs write
    fluently and which would lower to a `strcat` chain.
  Either is pure sugar over `strcat` with a deterministic lowering, so it fits
  the bijection model — but template strings raise a normalization question
  (which JSON is canonical for a given interpolation). Worth prototyping; this is
  probably the highest-value ergonomic win beyond the base design.
- 🟡 **Escaped quotes are fine** because our string rules are JSON's. Good — no
  new escaping surface.
- 🟡 **Comment placement gets lossy.** The `// Error strings.` comment sits above
  a *group* of sibling locals. It can only lower to `$comment` on **one** node
  (e.g. the first local's value). Section headers (`// ===== Layer 6 =====`) and
  group comments have no natural single owner. We either (a) attach-to-next and
  accept minor semantic drift, (b) support a standalone `$comment`-only entry
  form, or (c) accept these are dropped. Needs a rule.
- 🔴 A comment attaching to a **scalar or array** local (e.g. `x = []`) has
  nowhere to put `$comment` (arrays hold no keys; scalars aren't objects). The
  attach-to-next-expression rule from `shorthand.md` §9 fails for these targets —
  lowering must either error or hoist the comment to the enclosing form.

---

## Summary of open issues (ranked)

1. 🔴 **`{` / `=>` overloading** (Pieces 2 & 7): function block vs data object,
   and function-`=>` vs arm-`=>`. This is the biggest grammar risk. Likely fix:
   distinct arm token (`->`) + content-sniffing or JS-style `=> ({...})`.
2. 🔴 **Invisible laziness** (Piece 2): `=` blocks read eager but are lazy;
   load-bearing for recursion. Needs a syntax cue or loud documentation.
3. 🔴 **String-building ergonomics** (Piece 8): add `++` or template strings as
   sugar over `strcat`.
4. 🟡 **`$get` vs path-string canonicalization** (Piece 3): pick one canonical
   JSON form; accept normalization of existing files.
5. 🟡 **`raw` consistency** (Pieces 4 & 5): guidance on when `raw` is required vs
   stylistic; it is *not* canonicalizable away.
6. 🟡 **Comment attachment** (Pieces 1 & 8): group/section comments and comments
   on non-object targets have no clean home.

None of these threaten the core design; they're all in the surface grammar and
its normal form. The code-first, keyword/operator, bijective approach holds up
well against a large real program — the bulk of `chess.jsonc` translates
mechanically and reads dramatically better than the JSON.
