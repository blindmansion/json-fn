// stretch-syntax.ts — Isolated syntax-level probes for json-fn shorthand.
//
// Each probe is its own tiny module string, parsed and run independently, so a
// parse-fatal gamble doesn't mask the others (a single .jfn is all-or-nothing).
// This complements stretch.ts, which probes runtime/stdlib behavior inside one
// module. Together they map where the surface syntax over- or under-promises.

import { callProgram, createStdlib, parseShorthand, type JSONType } from "../src";

function rawToLiteral(node: JSONType): JSONType {
  if (Array.isArray(node)) return node.map(rawToLiteral);
  if (node !== null && typeof node === "object") {
    if ("$raw" in node) return { $literal: (node as Record<string, JSONType>).$raw! };
    const out: Record<string, JSONType> = {};
    for (const [k, v] of Object.entries(node)) out[k] = rawToLiteral(v);
    return out;
  }
  return node;
}

const stdlib = createStdlib();

type Probe = { name: string; src: string; entry: string; args: JSONType[]; note: string };

const probes: Probe[] = [
  // ---- Parse-fatal originals (documented with their exact errors) ----
  {
    name: "letIn",
    src: `{ f: (n) => let { a: n + 1 } in a * 2 }`,
    entry: "f",
    args: [3],
    note: "let { } in expr  (used all over chess.jfn)",
  },
  {
    name: "matchNoElse",
    src: `{ f: (n) => match n { 1 -> "one", 2 -> "two" } }`,
    entry: "f",
    args: [1],
    note: "match without an else arm",
  },
  {
    name: "nestedWhere",
    src: `{ f: (n) => r where { r: (a * 2) where { a: n + 1 } } }`,
    entry: "f",
    args: [3],
    note: "where nested inside a where-binding value",
  },

  // ---- Records ----
  {
    name: "spreadObj",
    src: `{ f: (s) => { ...s, gen: 0 } }`,
    entry: "f",
    args: [{ a: 1 }],
    note: "object spread { ...s, k: v }",
  },
  {
    name: "computedKey",
    src: `{ f: (k, v) => { [k]: v } }`,
    entry: "f",
    args: ["x", 5],
    note: "computed key { [k]: v }",
  },
  {
    name: "objSiblingRef",
    src: `{ f: (n) => { y: n + 1, z: y * 2 } }`,
    entry: "f",
    args: [3],
    note: "object value referencing a sibling key",
  },

  // ---- Operators ----
  {
    name: "pipeOp",
    src: `{ f: (xs) => xs |> length }`,
    entry: "f",
    args: [[1, 2, 3]],
    note: "pipe operator xs |> length",
  },
  {
    name: "chainCompare",
    src: `{ f: (x) => 0 <= x <= 7 }`,
    entry: "f",
    args: [3],
    note: "chained comparison 0 <= x <= 7",
  },
  {
    name: "operatorShadow",
    src: `{ add: (a, b) => a - b, f: (x) => x + 1 }`,
    entry: "f",
    args: [10],
    note: "define add as subtract, then use + (desugars to add)",
  },

  // ---- Parameters ----
  {
    name: "defaultParam",
    src: `{ f: (a, b = 1) => a + b }`,
    entry: "f",
    args: [5],
    note: "default parameter (a, b = 1)",
  },
  {
    name: "restParam",
    src: `{ f: (...xs) => length(xs) }`,
    entry: "f",
    args: [1, 2, 3],
    note: "rest parameter (...xs)",
  },
  {
    name: "destructureParam",
    src: `{ f: ([a, b]) => a }`,
    entry: "f",
    args: [[1, 2]],
    note: "array-destructuring parameter",
  },

  // ---- Lexical / literals ----
  {
    name: "lineComment",
    src: `{ f: (n) => n + 1 // trailing comment\n}`,
    entry: "f",
    args: [2],
    note: "// line comment",
  },
  {
    name: "blockComment",
    src: `{ f: (n) => /* inline */ n + 1 }`,
    entry: "f",
    args: [2],
    note: "/* block comment */",
  },
  {
    name: "multilineStr",
    src: "{ f: () => `line one\nline two` }",
    entry: "f",
    args: [],
    note: "real newline inside a backtick string",
  },

  // ---- Spreads elsewhere ----
  {
    name: "spreadArray",
    src: `{ f: (xs) => [...xs, 99] }`,
    entry: "f",
    args: [[1, 2]],
    note: "array spread [...xs, 99]",
  },
  {
    name: "spreadCall",
    src: `{ g: (a, b) => a + b, f: (xs) => g(...xs) }`,
    entry: "f",
    args: [[3, 4]],
    note: "spread into call args g(...xs)",
  },

  // ---- Known-good escape hatches (for contrast in the writeup) ----
  {
    name: "negSlice",
    src: `{ f: (s) => slice(s, -2) }`,
    entry: "f",
    args: ["hello"],
    note: "negative slice index",
  },
  {
    name: "applyWorkaround",
    src: `{ inc: (n) => n + 1, twiceInc: (x) => apply(inc, [apply(inc, [x])]) }`,
    entry: "twiceInc",
    args: [0],
    note: "apply() as the escape hatch for calling fn values",
  },
];

function show(v: JSONType): string {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "$return" in v) return "<function>";
  const s = JSON.stringify(v);
  return s.length > 30 ? s.slice(0, 27) + "..." : s;
}

const rows: string[] = [];
for (const probe of probes) {
  let stage = "parse";
  try {
    const module = rawToLiteral(parseShorthand(probe.src)) as Record<string, JSONType>;
    stage = "run";
    const result = callProgram(module, probe.entry, probe.args, stdlib);
    rows.push(`  OK    ${probe.name.padEnd(18)} => ${show(result).padEnd(20)} [${probe.note}]`);
  } catch (e) {
    const msg = String(e).replace(/^(ParseError|Error):\s*/, "").split("\n")[0]!;
    const tag = stage === "parse" ? "PARSE " : "RUN   ";
    rows.push(`  ${tag}${probe.name.padEnd(18)} !! ${msg}`);
  }
}

console.log("\n  json-fn syntax gambles (each parsed/run in isolation):\n");
console.log(rows.join("\n"));
console.log("");
