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

describe("jfn eval bare functions", () => {
  test.each([
    { name: "zero-argument", source: "() => 42", expected: 42 },
    { name: "optional", source: "(value?) => value", expected: null },
    { name: "defaulted", source: "(value = 9) => value", expected: 9 },
  ])("invokes the $name function with the default empty argument array", (fixture) => {
    const result = runEval([fixture.source, "--compact"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(fixture.expected);
  });

  test.each([
    { name: "zero-argument", source: "() => 42", expected: 42 },
    { name: "optional", source: "(value?) => value", expected: null },
    { name: "defaulted", source: "(value = 9) => value", expected: 9 },
  ])("invokes the $name function with an explicit empty argument array", (fixture) => {
    const result = runEval([fixture.source, "--args", "[]", "--compact"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(fixture.expected);
  });

  test.each([
    { name: "default", args: [] },
    { name: "explicit", args: ["--args", "[]"] },
  ])("rejects missing required arguments with the $name empty array", (fixture) => {
    const result = runEval(["(value) => value", ...fixture.args]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("evaluation error:");
    expect(result.stderr).toContain("received 0");
  });

  test("retains non-empty bare function invocation", () => {
    const result = runEval(["(value) => value * value", "--args", "[9]", "--compact"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("81");
  });
});

describe("jfn eval arity diagnostics", () => {
  test.each([
    {
      name: "required-only upper bound",
      source: "((value) => null)(1, 2)",
      expected: "Expected exactly 1 argument, received 2.",
    },
    {
      name: "optional-only upper bound",
      source: "((first?, second?) => null)(1, 2, 3)",
      expected: "Expected 0 to 2 arguments, received 3.",
    },
    {
      name: "required-plus-optional lower bound",
      source: "((required, optional?) => null)()",
      expected:
        "Missing required argument at parameter position 1. Expected 1 to 2 arguments, received 0.",
    },
    {
      name: "required-plus-optional upper bound",
      source: "((required, optional?) => null)(1, 2, 3)",
      expected: "Expected 1 to 2 arguments, received 3.",
    },
    {
      name: "required-plus-defaulted upper bound",
      source: "((required, defaulted = 2) => null)(1, 2, 3)",
      expected: "Expected 1 to 2 arguments, received 3.",
    },
    {
      name: "mixed optional/defaulted upper bound",
      source: "((required, optional?, defaulted = 3) => null)(1, 2, 3, 4)",
      expected: "Expected 1 to 3 arguments, received 4.",
    },
    {
      name: "rest lower bound",
      source: "((required, ...rest) => null)()",
      expected:
        "Missing required argument at parameter position 1. Expected at least 1 argument, received 0.",
    },
  ])("reports the accepted range at the $name", ({ source, expected }) => {
    const result = runEval([source]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`jfn: evaluation error: ${expected}\n`);
  });
});

describe("jfn eval environment modes", () => {
  test("executes a direct environment entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-direct-entry-"));
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
          returns: { type: "integer" },
        },
      }),
    );

    try {
      const result = runEval(["--environment", environmentPath, "{ main: () => 42 }", "--compact"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("42");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  test("--function bypasses production entry validation and invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-development-function-"));
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
          returns: { type: "integer" },
        },
      }),
    );
    const module = '{ main: () => "invalid", demo: () => 9 }';

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

      expect(production.exitCode).toBe(1);
      expect(production.stderr).toContain('entry "main" result contract failed');
      expect(development.exitCode).toBe(0);
      expect(development.stderr).toBe("");
      expect(development.stdout.trim()).toBe("9");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("enforces environment entry ranges while preserving optional omission", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-entry-optionals-"));
    const environmentPath = join(directory, "environment.json");
    const module =
      "{ main: (required, optional?, defaulted = 7) => pure([required, optional, defaulted]) }";

    try {
      writeFileSync(
        environmentPath,
        JSON.stringify({
          functions: {},
          effects: {},
          entry: {
            name: "main",
            required: [{ type: "integer" }],
            optional: [{ type: "integer" }, { type: "integer" }],
            returns: { task: true },
          },
        }),
      );

      for (const [args, expected] of [
        [[1], [1, null, 7]],
        [
          [1, 2],
          [1, 2, 7],
        ],
        [
          [1, 2, 3],
          [1, 2, 3],
        ],
      ] as const) {
        const result = runEval([
          "--environment",
          environmentPath,
          "--args",
          JSON.stringify(args),
          module,
          "--compact",
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual(expected);
      }

      for (const args of [[], [1, 2, 3, 4], [1, "wrong"], [1, null]]) {
        const result = runEval([
          "--environment",
          environmentPath,
          "--args",
          JSON.stringify(args),
          module,
        ]);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain('entry "main" arguments contract failed');
      }

      writeFileSync(
        environmentPath,
        JSON.stringify({
          functions: {},
          effects: {},
          entry: {
            name: "main",
            required: [],
            optional: [{ anyOf: [{ type: "integer" }, { type: "null" }] }],
            returns: { task: { anyOf: [{ type: "integer" }, { type: "null" }] } },
          },
        }),
      );
      const nullableModule = "{ main: (value?) => pure(value) }";

      for (const [args, expected] of [
        [[], null],
        [[3], 3],
        [[null], null],
      ] as const) {
        const result = runEval([
          "--environment",
          environmentPath,
          "--args",
          JSON.stringify(args),
          nullableModule,
          "--compact",
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual(expected);
      }

      const wrongNullable = runEval([
        "--environment",
        environmentPath,
        "--args",
        '["wrong"]',
        nullableModule,
      ]);
      expect(wrongNullable.exitCode).toBe(1);
      expect(wrongNullable.stdout).toBe("");
      expect(wrongNullable.stderr).toContain('entry "main" arguments contract failed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
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
