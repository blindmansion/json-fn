import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  checkModule,
  loadBuiltinTable,
  loadEnvironmentContract,
  loadDeploymentProfile,
  parseShorthand,
  prepareDeployment,
  runTask,
  type EnvironmentContract,
  type DeploymentProfile,
  type JSONType,
} from "../src";

const examples = join(import.meta.dir, "../../examples");

function loadModule(path: string): Record<string, JSONType> {
  return parseShorthand(readFileSync(path, "utf-8")) as Record<string, JSONType>;
}

function dungeonFixture(): {
  module: Record<string, JSONType>;
  contract: EnvironmentContract;
  profile: DeploymentProfile;
} {
  const directory = join(examples, "dungeon");
  const contract = loadEnvironmentContract(join(directory, "dungeon.contract.json"));
  return {
    module: loadModule(join(directory, "dungeon.jfn")),
    contract,
    profile: loadDeploymentProfile(join(directory, "dungeon.profile.json"), contract),
  };
}

describe("typed host-contract examples", () => {
  test("loads every bundled deployment profile from disk", () => {
    for (const name of [
      "critical-path",
      "dungeon",
      "fulfillment",
      "orbital-traffic",
      "parcel-sorter",
      "spreadsheet",
      "thermostat",
    ]) {
      const directory = join(examples, name);
      const contract = loadEnvironmentContract(join(directory, `${name}.contract.json`));
      expect(
        loadDeploymentProfile(join(directory, `${name}.profile.json`), contract),
      ).toBeDefined();
    }
  });

  test("critical-path satisfies its operator-owned contract", () => {
    const directory = join(examples, "critical-path");
    const contract = loadEnvironmentContract(join(directory, "critical-path.contract.json"));
    const module = loadModule(join(directory, "critical-path.jfn"));
    expect(checkModule(module, loadBuiltinTable(), { contract })).toEqual([]);
  });

  test("critical-path demo entry matches CPM oracle", async () => {
    const directory = join(examples, "critical-path");
    const contract = loadEnvironmentContract(join(directory, "critical-path.contract.json"));
    const module = loadModule(join(directory, "critical-path.jfn"));
    const profile = loadDeploymentProfile(join(directory, "critical-path.profile.json"), contract);
    const report = (await runTask(
      prepareDeployment({
        module,
        contract,
        profile: profile as Extract<DeploymentProfile, { mode: "live" }>,
        adapter: { functions: {}, effects: {} },
      }),
      [],
    )) as { makespan: number; criticalNames: string[]; slacky: string[] };

    expect(report.makespan).toBe(16);
    expect(report.criticalNames).toEqual([
      "Write spec",
      "UI prototype",
      "Integration",
      "QA pass",
      "Release",
    ]);
    expect(report.slacky).toEqual(["API skeleton", "Schema migrate", "Docs polish"]);
  });

  test("dungeon satisfies its operator-owned contract", () => {
    const { module, contract } = dungeonFixture();
    expect(checkModule(module, loadBuiltinTable(), { contract })).toEqual([]);
  });

  test("dungeon runs through validated entry and effect boundaries", async () => {
    const { module, contract, profile } = dungeonFixture();
    const commands = ["take", "go north", "go east", "unlock"];
    const transcript: string[] = [];

    const effects = {
      input: () => commands.shift() ?? null,
      print: (message: JSONType) => {
        transcript.push(message as string);
        return null;
      },
    };
    const result = await runTask(
      prepareDeployment({
        module,
        contract: contract,
        profile: profile as Extract<DeploymentProfile, { mode: "live" }>,
        adapter: { functions: {}, effects },
      }),
      [{ at: "cell", held: [] }],
    );

    expect(result).toBe("The key grinds, the gate swings wide. You are free!");
    expect(transcript.at(-1)).toBe("The key grinds, the gate swings wide. You are free!");
  });
});
