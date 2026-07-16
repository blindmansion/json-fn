import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  checkModule,
  createStdlib,
  loadBuiltinTable,
  loadEnvironment,
  parseShorthand,
  runTask,
  type Environment,
  type JSONType,
} from "../src";

const examples = join(import.meta.dir, "../../examples");

function loadModule(path: string): Record<string, JSONType> {
  return parseShorthand(readFileSync(path, "utf-8")) as Record<string, JSONType>;
}

function fixture(name: "dungeon" | "thermostat"): {
  module: Record<string, JSONType>;
  environment: Environment;
} {
  const directory = name === "thermostat" ? join(examples, "typed") : examples;
  return {
    module: loadModule(join(directory, `${name}.jfn`)),
    environment: loadEnvironment(join(directory, `${name}.environment.json`)),
  };
}

describe("typed host-environment examples", () => {
  test.each(["thermostat", "dungeon"] as const)(
    "%s satisfies its operator-owned environment",
    (name) => {
      const { module, environment } = fixture(name);
      expect(checkModule(module, loadBuiltinTable(), { environment })).toEqual([]);
    },
  );

  test("thermostat runs through validated entry and effect boundaries", async () => {
    const { module, environment } = fixture("thermostat");
    const readings: JSONType[] = [
      { temp: 18, battery: 90 },
      { temp: 20, battery: 88 },
      { temp: 24, battery: 85 },
      { temp: 21, battery: 84 },
    ];
    const modes: JSONType[] = [];
    const logs: JSONType[] = [];

    const result = await runTask(
      module,
      environment,
      [{ config: { target: 21, tolerance: 1.5 }, mode: "off" }, 100],
      {
        registry: createStdlib(),
        capabilities: {
          "sensor.read": () => readings.shift() ?? null,
          "hvac.set": (mode) => {
            modes.push(mode);
            return null;
          },
          log: (message) => {
            logs.push(message);
            return null;
          },
        },
      },
    );

    expect(result).toEqual({ config: { target: 21, tolerance: 1.5 }, mode: "off" });
    expect(modes).toEqual(["heat", "off", "cool", "off"]);
    expect(logs).toHaveLength(4);
  });

  test("dungeon runs through validated entry and effect boundaries", async () => {
    const { module, environment } = fixture("dungeon");
    const commands = ["take", "go north", "go east", "unlock"];
    const transcript: string[] = [];

    const result = await runTask(module, environment, [{ at: "cell", held: [] }], {
      registry: createStdlib(),
      capabilities: {
        input: () => commands.shift() ?? null,
        print: (message) => {
          transcript.push(message as string);
          return null;
        },
      },
    });

    expect(result).toBe("The key grinds, the gate swings wide. You are free!");
    expect(transcript.at(-1)).toBe("The key grinds, the gate swings wide. You are free!");
  });
});
