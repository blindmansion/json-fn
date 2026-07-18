// parcel-sorter.ts — host driver for examples/typed/parcel-sorter.jfn.
//
// The guest owns routing policy and performs three declared effects:
// `scanner.read`, `conveyor.route`, and `log`. This host connects those effects
// to a mock loading dock. Set PARCEL_SORTER_FAULT to feed the belt an overweight
// parcel and observe the guest's typed `raise` at the host boundary.
//
// Run it:       bun run typescript/examples/parcel-sorter.ts
// Trip a fault: PARCEL_SORTER_FAULT=1 bun run typescript/examples/parcel-sorter.ts

import {
  runTask,
  createStdlib,
  loadEnvironment,
  parseShorthand,
  TaskRaiseError,
  type JSONType,
} from "../src";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
  join(import.meta.dir, "../../examples/parcel-sorter.jfn"),
  "utf-8",
);
const sorter = parseShorthand(source) as Record<string, JSONType>;
const environment = loadEnvironment(
  join(import.meta.dir, "../../examples/parcel-sorter.environment.json"),
);

const normalShift = [
  { id: "N-104", region: "north", weightKg: 4.2, express: false },
  { id: "X-205", region: "south", weightKg: 1.1, express: true },
  { id: "I-306", region: "international", weightKg: 8.5, express: false },
];

const faultyShift = [
  { id: "N-104", region: "north", weightKg: 4.2, express: false },
  { id: "N-900", region: "north", weightKg: 42, express: false },
];

const parcels: JSONType[] = process.env.PARCEL_SORTER_FAULT ? faultyShift : normalShift;
let cursor = 0;

const capabilities = {
  "scanner.read": (): JSONType => (cursor < parcels.length ? parcels[cursor++]! : null),
  "conveyor.route": (id: JSONType, lane: JSONType): JSONType => {
    console.log(`  belt ${id as string} -> ${lane as string}`);
    return null;
  },
  log: (message: JSONType): JSONType => {
    console.log(`  ${message as string}`);
    return null;
  },
};

console.log("starting parcel shift:");
try {
  const finalState = await runTask(sorter, environment, [{ routed: 0 }, 100], {
    registry: createStdlib(),
    capabilities,
  });
  console.log("\nshift complete:");
  console.log(JSON.stringify(finalState, null, 2));
  process.exit(0);
} catch (err) {
  if (err instanceof TaskRaiseError) {
    console.error(`\nparcel rejected: ${JSON.stringify(err.payload)}`);
  } else {
    console.error(`\nsorter failed (evaluator error): ${(err as Error).message}`);
  }
  process.exit(1);
}
