// spreadsheet.ts — host driver for examples/spreadsheet/spreadsheet.jfn.
//
// The spreadsheet engine is entirely pure: the contract declares no host
// functions and no effects, so the runtime adapter is empty and the `demo`
// entry returns a direct (non-task) report. This host runs the entry through
// the standard deployment path and asserts the expected cell values,
// including the three deliberate failure modes (reference cycle, division by
// zero, missing cell).
//
// Run it: bun run typescript/examples/spreadsheet.ts

import {
  loadDeploymentProfile,
  loadEnvironmentContract,
  parseShorthand,
  prepareDeployment,
  runTask,
  type JSONType,
} from "../src";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
  join(import.meta.dir, "../../examples/spreadsheet/spreadsheet.jfn"),
  "utf-8",
);
const sheetModule = parseShorthand(source) as Record<string, JSONType>;
const contract = loadEnvironmentContract(
  join(import.meta.dir, "../../examples/spreadsheet/spreadsheet.contract.json"),
);
const profile = loadDeploymentProfile(
  join(import.meta.dir, "../../examples/spreadsheet/spreadsheet.profile.json"),
  contract,
);
if (profile.mode !== "live") throw new Error("spreadsheet requires a live deployment profile");

const report = (await runTask(
  prepareDeployment({
    module: sheetModule,
    contract,
    profile,
    adapter: { functions: {}, effects: {} },
  }),
  [],
)) as { cells: Record<string, string>; summary: string };

console.log("cells:");
for (const [id, value] of Object.entries(report.cells).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${id.padEnd(3)} ${value}`);
}
console.log(`\nsummary: ${report.summary}`);

// Lightweight assertions covering the happy path and every failure mode.
const expected: Record<string, string> = {
  D1: "6400",
  D2: "5920",
  D3: "480",
  D4: "7.5",
  F1: "#ERR cycle: F1 -> F2 -> F1",
  G1: "#ERR division by zero",
  H1: "#ERR missing cell Z9",
};
const failures = Object.entries(expected).filter(([id, want]) => report.cells[id] !== want);
if (failures.length > 0 || report.summary !== "profit 480 on revenue 6400 — margin 7.5% (steady)") {
  for (const [id, want] of failures) {
    console.error(
      `FAIL ${id}: expected ${JSON.stringify(want)}, got ${JSON.stringify(report.cells[id])}`,
    );
  }
  console.error("spreadsheet example produced unexpected output");
  process.exit(1);
}
console.log("\nall assertions passed");
