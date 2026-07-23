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
  const contract = loadEnvironmentContract(join(examples, "dungeon.contract.json"));
  return {
    module: loadModule(join(examples, "dungeon.jfn")),
    contract,
    profile: loadDeploymentProfile(join(examples, "dungeon.profile.json"), contract),
  };
}

describe("typed host-contract examples", () => {
  test("loads every bundled deployment profile from disk", () => {
    for (const name of ["dungeon", "orbital-traffic", "parcel-sorter", "thermostat"]) {
      const contract = loadEnvironmentContract(join(examples, `${name}.contract.json`));
      expect(loadDeploymentProfile(join(examples, `${name}.profile.json`), contract)).toBeDefined();
    }
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
