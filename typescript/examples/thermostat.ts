// thermostat.ts — host driver for examples/thermostat-checked.jfn.
//
// The controller's `loop` performs exactly three effects — `sensor.read` (get
// the next reading), `hvac.set` (actuate), and `log` (narrate) — through the
// narrow `Device` capability record, and escalates a bad reading as an
// in-language `raise`. The example's own `runScript` handler interprets those
// *in-language* for its demos; this host instead answers them from a mock
// sensor rig via `runTask`, so the same pure control logic drives "real" gear.
//
// The (checkable) example is loaded here on purpose: the version a host ships
// is the one that passes `jfn check`. Its untyped twin, examples/thermostat.jfn,
// is the goal we are typing toward — it evaluates identically but doesn't check.
//
// A `null` reading (the sensor rig is out of data) ends the run gracefully via
// the loop's own `isNull` guard. A dead battery or implausible temperature is
// raised in-language and surfaces here as a TaskRaiseError carrying the fault.
//
// Run it:              bun run typescript/examples/thermostat.ts
// Trip a fault:        THERMOSTAT_FAULT=1 bun run typescript/examples/thermostat.ts

import { runTask, createStdlib, parseShorthand, TaskRaiseError, type JSONType } from "../src";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
  join(import.meta.dir, "../../examples/thermostat-checked.jfn"),
  "utf-8",
);
const controller = parseShorthand(source) as Record<string, JSONType>;

// A scripted sensor rig: each `sensor.read` shifts the next reading off this
// queue; when it runs dry the capability returns null and the loop stops.
const normalRun = [
  { temp: 18, battery: 90 },
  { temp: 20, battery: 88 },
  { temp: 24, battery: 85 },
  { temp: 21, battery: 84 },
];

// The same run, but the third reading has a dead battery — the controller
// `raise`s LowBattery and this host catches it as a TaskRaiseError.
const faultyRun = [
  { temp: 18, battery: 90 },
  { temp: 20, battery: 88 },
  { temp: 24, battery: 0 },
];

const readings: JSONType[] = process.env.THERMOSTAT_FAULT ? faultyRun : normalRun;
let cursor = 0;

const capabilities = {
  "sensor.read": (): JSONType => (cursor < readings.length ? readings[cursor++]! : null),
  "hvac.set": (mode: JSONType): JSONType => {
    console.log(`  HVAC -> ${mode as string}`);
    return null;
  },
  log: (msg: JSONType): JSONType => {
    console.log(`  ${msg as string}`);
    return null;
  },
};

const start: JSONType = { config: { target: 21, tolerance: 1.5 }, mode: "off" };

console.log("running controller:");
try {
  // `fuel` bounds the loop; the sensor rig runs dry well before it, so the run
  // ends on the loop's own null guard rather than the fuel limit.
  const finalState = await runTask(controller, "loop", [start, 100], createStdlib(), capabilities);
  console.log("\nfinal state:");
  console.log(JSON.stringify(finalState, null, 2));
  process.exit(0);
} catch (err) {
  // An in-language `raise` the controller never handled comes back as a
  // structured payload; any other evaluator error is a bug in the control logic.
  if (err instanceof TaskRaiseError) {
    console.error(`\ncontroller raised (uncaught fault): ${JSON.stringify(err.payload)}`);
  } else {
    console.error(`\ncontroller failed (evaluator error): ${(err as Error).message}`);
  }
  process.exit(1);
}
