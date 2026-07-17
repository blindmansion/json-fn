import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const examples = join(import.meta.dir, "../../examples");

function runEval(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, "eval", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("jfn eval environment modes", () => {
  test("distinguishes the authoritative entry from a development function", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-environment-"));
    const environmentPath = join(directory, "environment.json");
    writeFileSync(
      environmentPath,
      JSON.stringify({
        functions: {},
        effects: {},
        entry: {
          name: "main",
          required: [],
          optional: [],
          returns: { task: { type: "integer" } },
        },
      }),
    );
    const module = "{ main: () => pure(7), demo: () => 9 }";

    try {
      const production = runEval(["--environment", environmentPath, module, "--compact"]);
      const development = runEval([
        "--environment",
        environmentPath,
        "--function",
        "demo",
        module,
        "--compact",
      ]);

      expect(production.exitCode).toBe(0);
      expect(production.stdout.trim()).toBe("7");
      expect(development.exitCode).toBe(0);
      expect(development.stdout.trim()).toBe("9");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "thermostat",
      module: join(examples, "typed/thermostat.jfn"),
      environment: join(examples, "typed/thermostat.environment.json"),
      expectedKeys: ["run", "fault"],
    },
    {
      name: "dungeon",
      module: join(examples, "dungeon.jfn"),
      environment: join(examples, "dungeon.environment.json"),
      expectedKeys: ["escape", "silence"],
    },
  ])("development-evaluates the $name demo with its environment", (fixture) => {
    const result = runEval([
      "--file",
      fixture.module,
      "--environment",
      fixture.environment,
      "--function",
      "demo",
      "--compact",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(Object.keys(JSON.parse(result.stdout))).toEqual([...fixture.expectedKeys]);
  });

  test("--function requires an environment", () => {
    const result = runEval(["--function", "demo", "{ demo: () => 1 }"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--function requires --environment");
  });
});
