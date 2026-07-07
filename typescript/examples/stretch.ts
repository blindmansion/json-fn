// stretch.ts — Probe harness for examples/stretch.jfn.
//
// Loads the shorthand, then invokes each probe function with representative
// arguments, catching parse/runtime errors so a single failure doesn't mask
// the rest. Prints a table of outcomes. This is an experiment: the .jfn was
// written from *only* two example files, to see where the surface syntax
// over-promises relative to what the interpreter actually supports.

import { callProgram, createStdlib, parseShorthand, type JSONType } from "../src";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "../../examples/stretch.jfn"), "utf-8");

let module: Record<string, JSONType>;
try {
  module = parseShorthand(source) as Record<string, JSONType>;
} catch (e) {
  console.error("PARSE FAILED for the whole file:");
  console.error(String(e));
  process.exit(1);
}

const stdlib = createStdlib();

type Probe = { name: string; args: JSONType[]; note: string };

const probes: Probe[] = [
  // Dense lambdas
  { name: "curryPartial", args: [], note: "(a)=>(b)=>.. partial -> returns a fn" },
  { name: "curryFull", args: [], note: "add(10)(5) chained call" },
  { name: "chainedCall", args: [], note: "add(3)(4)" },
  { name: "applyTwice", args: [], note: "twice((n)=>n+1)(0)" },
  { name: "iife", args: [], note: "((x)=>x*x)(9)" },
  { name: "composed", args: [], note: "compose(+1,*2)(10)" },
  { name: "bareRef", args: [[1, 2, 3]], note: "map(dbl, xs) bare fn ref" },
  { name: "partialMapper", args: [[1, 2, 3]], note: "map(add(1), xs) partial as mapper" },
  { name: "mapIndexed", args: [["a", "b"]], note: "map((x,i)=>..) index param" },

  // 'Expected' stdlib
  { name: "keepEvens", args: [[1, 2, 3, 4]], note: "filter" },
  { name: "total", args: [[1, 2, 3, 4]], note: "reduce" },
  { name: "everyPos", args: [[1, 2, 3]], note: "every" },
  { name: "findBig", args: [[1, 200, 3]], note: "find" },
  { name: "sumOf", args: [[1, 2, 3]], note: "sum" },
  { name: "maxOf", args: [[1, 5, 3]], note: "max(array)" },
  { name: "minOf", args: [[1, 5, 3]], note: "min(array)" },
  { name: "absOf", args: [-5], note: "abs" },
  { name: "roundOf", args: [2.6], note: "round" },
  { name: "sqrtOf", args: [9], note: "sqrt" },
  { name: "powOf", args: [2, 3], note: "pow" },
  { name: "sortOf", args: [[3, 1, 2]], note: "sort(xs) w/o comparator" },
  { name: "sortByAge", args: [[{ age: 3 }, { age: 1 }]], note: "sortBy" },
  { name: "uniqueOf", args: [[1, 1, 2]], note: "unique" },
  { name: "flattenOf", args: [[[1], [2]]], note: "flatten" },
  {
    name: "zipOf",
    args: [
      [1, 2],
      [3, 4],
    ],
    note: "zip",
  },
  { name: "takeOf", args: [[1, 2, 3], 2], note: "take" },
  { name: "dropOf", args: [[1, 2, 3], 1], note: "drop" },
  { name: "headOf", args: [[1, 2, 3]], note: "head" },
  { name: "tailOf", args: [[1, 2, 3]], note: "tail" },
  { name: "lastOf", args: [[1, 2, 3]], note: "last" },
  { name: "countOf", args: [[1, -1, 2]], note: "count" },

  // Strings
  { name: "splitWords", args: ["a b c"], note: "split" },
  { name: "replaceOf", args: ["banana"], note: "replace" },
  { name: "padOf", args: [5], note: "padStart" },
  { name: "repeatOf", args: ["ab", 3], note: "repeat" },
  { name: "startsOf", args: ["http://x"], note: "startsWith" },
  { name: "charAtOf", args: ["hello", 1], note: "s[i] string index" },
  { name: "strPlus", args: ["a", "b"], note: "+ on strings" },
  { name: "strIncludes", args: ["axb"], note: "includes on string" },

  // Objects / equality
  { name: "keysOf", args: [{ a: 1, b: 2 }], note: "keys" },
  { name: "valuesOf", args: [{ a: 1, b: 2 }], note: "values" },
  { name: "entriesOf", args: [{ a: 1 }], note: "entries" },
  { name: "dynGet", args: [{ x: 9 }, "x"], note: "obj[var] dynamic index" },
  { name: "missingKey", args: [{ a: 1 }], note: "obj.nope missing key" },
  {
    name: "deepEq",
    args: [
      [1, 2],
      [1, 2],
    ],
    note: "== on arrays (deep?)",
  },
  { name: "sameArr", args: [], note: "[1,2,3] == [1,2,3]" },

  // Operators / truthiness
  { name: "orDefault", args: [0, 99], note: "if 0 then.. (truthiness)" },
  { name: "notOf", args: [0], note: "!0 (truthiness)" },
  { name: "halfOf", args: [7], note: "7 / 2 division" },
  { name: "negMod", args: [-7, 3], note: "-7 % 3" },

  // match / cond
  { name: "matchVar", args: [5, 5], note: "match arm is a variable?" },
  { name: "matchNum", args: [2], note: "match on number" },
  { name: "matchBool", args: [true], note: "match on bool, NO else" },
  { name: "condNoElse", args: [5], note: "cond no else, branch hits" },
  { name: "condNoElse", args: [-1], note: "cond no else, no branch hits" },

  // scope / module
  { name: "useNamespace", args: [10], note: "nested object as namespace" },
  { name: "shadowTest", args: [50], note: "local shadows top-level add" },
  { name: "mutualLocal", args: [10], note: "local mutual recursion" },
  { name: "letInWhere", args: [3], note: "let..in inside where" },
  { name: "whereAfterLet", args: [3], note: "where after let..in" },
];

function show(v: JSONType): string {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "$return" in v) {
    return "<function>";
  }
  const s = JSON.stringify(v);
  return s.length > 45 ? s.slice(0, 42) + "..." : s;
}

let ok = 0;
let fail = 0;
const rows: string[] = [];
for (const probe of probes) {
  const label = `${probe.name}(${probe.args.map((a) => JSON.stringify(a)).join(", ")})`;
  try {
    const result = callProgram(module, probe.name, probe.args, stdlib);
    ok++;
    rows.push(`  ✓  ${label.padEnd(38)} => ${show(result).padEnd(24)}  [${probe.note}]`);
  } catch (e) {
    fail++;
    const msg = String(e)
      .replace(/^Error:\s*/, "")
      .split("\n")[0]!;
    rows.push(`  ✗  ${label.padEnd(38)} !! ${msg.slice(0, 40).padEnd(24)}  [${probe.note}]`);
  }
}

console.log("\n  json-fn stretch probes — parsed OK, running each:\n");
console.log(rows.join("\n"));
console.log(`\n  ${ok} worked, ${fail} failed out of ${probes.length}.\n`);
