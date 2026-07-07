// p1-shorthand.ts — runs examples/p1-shorthand.jfn.
//
// Verifies the two P1 items from docs/shorthand-action-items.md:
//   P1a: function-valued parameter calls (`twice`/`compose`/`applyTo`).
//   P1b: expression-level `where` (binding values, if/then/else, cond arms).

import { callProgram, createStdlib, parseShorthand, type JSONType } from "../src";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "../../examples/p1-shorthand.jfn"), "utf-8");

let module: Record<string, JSONType>;
try {
  module = parseShorthand(source) as Record<string, JSONType>;
} catch (e) {
  console.error("PARSE FAILED for the whole file:");
  console.error(String(e));
  process.exit(1);
}

const stdlib = createStdlib();

type Probe = { name: string; args: JSONType[]; expected: JSONType; note: string };

const probes: Probe[] = [
  { name: "twiceInc", args: [], expected: 7, note: "P1a: twice(inc)(5)" },
  { name: "composeTest", args: [], expected: 12, note: "P1a: compose(dbl, inc)(5)" },
  { name: "applyToTest", args: [], expected: 42, note: "P1a: applyTo(dbl, 21)" },
  { name: "nestedWhereTest", args: [], expected: 8, note: "P1b: where in where-binding" },
  { name: "valueWhereTest", args: [], expected: 20, note: "P1b: where on binding value" },
  { name: "parenWhereTest", args: [], expected: 21, note: "P1b: where in parenthesized group" },
  { name: "ifBranchWhereTest", args: [], expected: 41, note: "P1b: where on if branch" },
  { name: "condArmWhereTest", args: [], expected: 222, note: "P1b: where on cond arm" },
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
    rows.push(`  ${mark}  ${label.padEnd(30)} ${got.padEnd(30)}  [${probe.note}]`);
  } catch (e) {
    fail++;
    const msg = String(e)
      .replace(/^Error:\s*/, "")
      .split("\n")[0]!;
    rows.push(`  ✗  ${label.padEnd(30)} !! ${msg.slice(0, 26).padEnd(27)}  [${probe.note}]`);
  }
}

console.log("\n  P1 shorthand probes:\n");
console.log(rows.join("\n"));
console.log(`\n  ${ok} passed, ${fail} failed out of ${probes.length}.\n`);

if (fail > 0) process.exit(1);
