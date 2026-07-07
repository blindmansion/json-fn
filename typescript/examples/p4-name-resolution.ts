// p4-name-resolution.ts — runs examples/p4-name-resolution.jfn.
//
// Loads the shorthand module, invokes each probe, and checks it against the
// expected value. Every probe demonstrates a facet of the unified, lexical-first
// name-resolution rule (params/where-locals/module bindings shadow same-named
// stdlib globals; bare registry names are `&`-free references), while keeping
// local/mutual recursion working.

import { callProgram, createStdlib, parseShorthand, type JSONType } from "../src";
import { readFileSync } from "fs";
import { join } from "path";

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

const source = readFileSync(
  join(import.meta.dir, "../../examples/p4-name-resolution.jfn"),
  "utf-8",
);

let module: Record<string, JSONType>;
try {
  module = rawToLiteral(parseShorthand(source)) as Record<string, JSONType>;
} catch (e) {
  console.error("PARSE FAILED for the whole file:");
  console.error(String(e));
  process.exit(1);
}

const stdlib = createStdlib();

type Probe = { name: string; args: JSONType[]; expected: JSONType; note: string };

const probes: Probe[] = [
  {
    name: "paramShadowsOperator",
    args: [],
    expected: 9,
    note: "param `add` shadows `+`; `sub` bare ref",
  },
  {
    name: "paramShadowsStdlibCall",
    args: [],
    expected: 20,
    note: "param `map` shadows stdlib map",
  },
  {
    name: "localShadowsLength",
    args: [[1, 2, 3]],
    expected: 999,
    note: "where-local `length` shadows stdlib",
  },
  {
    name: "nonFnLocalNoHijack",
    args: [10],
    expected: 11,
    note: "value local `add:5` does NOT hijack `+`",
  },
  {
    name: "bareNameValue",
    args: [],
    expected: "length",
    note: "bare registry name -> reference (no &)",
  },
  {
    name: "bareNameAsArg",
    args: [
      [
        [1, 2],
        [3, 4, 5],
      ],
    ],
    expected: [2, 3],
    note: "map(length, xss) without &",
  },
  {
    name: "localShadowsValue",
    args: [],
    expected: 42,
    note: "local wins over stdlib in value pos",
  },
  {
    name: "escapingShadow",
    args: [],
    expected: 50,
    note: "param shadow survives escaping closure",
  },
  { name: "fact5", args: [], expected: 120, note: "local recursion (registry dispatch)" },
  { name: "isTenEven", args: [], expected: true, note: "mutual recursion via where-locals" },
  {
    name: "paramShadowsStar",
    args: [],
    expected: 13,
    note: "param `mul` shadows `*`; `add` bare ref",
  },
  { name: "composedShadow", args: [], expected: 60, note: "combinator captures shadowing params" },
  {
    name: "moduleShadow",
    args: [],
    expected: "module-sum-shadow",
    note: "module fn shadows stdlib `sum`",
  },
];

function show(v: JSONType): string {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > 22 ? s.slice(0, 19) + "..." : String(s);
}

let ok = 0;
let fail = 0;
const rows: string[] = [];
for (const probe of probes) {
  const label = `${probe.name}(${probe.args.map((a) => JSON.stringify(a)).join(", ")})`;
  try {
    const result = callProgram(module, probe.name, probe.args, stdlib);
    const passed = JSON.stringify(result) === JSON.stringify(probe.expected);
    if (passed) ok++;
    else fail++;
    const mark = passed ? "✓" : "✗";
    const got = passed ? `=> ${show(result)}` : `=> ${show(result)} (want ${show(probe.expected)})`;
    rows.push(`  ${mark}  ${label.padEnd(34)} ${got.padEnd(30)}  [${probe.note}]`);
  } catch (e) {
    fail++;
    const msg = String(e)
      .replace(/^Error:\s*/, "")
      .split("\n")[0]!;
    rows.push(`  ✗  ${label.padEnd(34)} !! ${msg.slice(0, 26).padEnd(27)}  [${probe.note}]`);
  }
}

console.log("\n  P4 name-resolution probes:\n");
console.log(rows.join("\n"));
console.log(`\n  ${ok} passed, ${fail} failed out of ${probes.length}.\n`);

if (fail > 0) process.exit(1);
