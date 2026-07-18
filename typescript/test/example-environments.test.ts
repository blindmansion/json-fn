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

function dungeonFixture(): {
  module: Record<string, JSONType>;
  environment: Environment;
} {
  return {
    module: loadModule(join(examples, "dungeon.jfn")),
    environment: loadEnvironment(join(examples, "dungeon.environment.json")),
  };
}

describe("typed host-environment examples", () => {
  test("dungeon satisfies its operator-owned environment", () => {
    const { module, environment } = dungeonFixture();
    expect(checkModule(module, loadBuiltinTable(), { environment })).toEqual([]);
  });

  test("dungeon runs through validated entry and effect boundaries", async () => {
    const { module, environment } = dungeonFixture();
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
