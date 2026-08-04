// critical-path.ts — host driver for examples/critical-path/critical-path.jfn.
//
// Pure CPM scheduling: empty adapter, contract entry `demo` returns a direct
// report (not a task). Asserts makespan, critical path names, and slack tasks
// for the bundled product-launch DAG.
//
// Run it: bun run typescript/examples/critical-path.ts

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
  join(import.meta.dir, "../../examples/critical-path/critical-path.jfn"),
  "utf-8",
);
const cpmModule = parseShorthand(source) as Record<string, JSONType>;
const contract = loadEnvironmentContract(
  join(import.meta.dir, "../../examples/critical-path/critical-path.contract.json"),
);
const profile = loadDeploymentProfile(
  join(import.meta.dir, "../../examples/critical-path/critical-path.profile.json"),
  contract,
);
if (profile.mode !== "live") throw new Error("critical-path requires a live deployment profile");

const report = (await runTask(
  prepareDeployment({
    module: cpmModule,
    contract,
    profile,
    adapter: { functions: {}, effects: {} },
  }),
  [],
)) as { makespan: number; criticalNames: string[]; slacky: string[] };

console.log(JSON.stringify(report, null, 2));

const expected = {
  makespan: 16,
  criticalNames: ["Write spec", "UI prototype", "Integration", "QA pass", "Release"],
  slacky: ["API skeleton", "Schema migrate", "Docs polish"],
};

let failed = false;
if (report.makespan !== expected.makespan) {
  console.error(`FAIL makespan: expected ${expected.makespan}, got ${report.makespan}`);
  failed = true;
}
if (JSON.stringify(report.criticalNames) !== JSON.stringify(expected.criticalNames)) {
  console.error(
    `FAIL criticalNames: expected ${JSON.stringify(expected.criticalNames)}, got ${JSON.stringify(report.criticalNames)}`,
  );
  failed = true;
}
if (JSON.stringify(report.slacky) !== JSON.stringify(expected.slacky)) {
  console.error(
    `FAIL slacky: expected ${JSON.stringify(expected.slacky)}, got ${JSON.stringify(report.slacky)}`,
  );
  failed = true;
}

if (failed) process.exit(1);
console.log("\nall assertions passed");
