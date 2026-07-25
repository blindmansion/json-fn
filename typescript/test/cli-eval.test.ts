import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const examples = join(import.meta.dir, "../../examples");

function runCli(
  command: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, command, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runEval(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  return runCli("eval", args);
}

describe("jfn shorthand $let cutover", () => {
  test("to-json emits $let and to-shorthand prints it", () => {
    const lowered = runCli("to-json", ["x + 1 where { x: 2 }", "--compact"]);
    expect(lowered.exitCode).toBe(0);
    expect(JSON.parse(lowered.stdout)).toEqual({
      $let: { x: 2 },
      $in: { $call: "add", $args: [{ $var: "x" }, 1] },
    });

    const raised = runCli("to-shorthand", [JSON.stringify({ $let: { x: 2 }, $in: { $var: "x" } })]);
    expect(raised.exitCode).toBe(0);
    expect(raised.stdout.trim()).toBe("x where {\n  x: 2\n}");
  });

  test("to-shorthand reports evaluator captures", () => {
    const result = runCli("to-shorthand", [
      JSON.stringify({ $return: 1, $captures: { helper: { $return: 2 } } }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime closure state has no shorthand syntax");
  });

  test("surface conversion rejects array-valued function references in both directions", () => {
    const lowered = runCli("to-json", ['&(["add", 1, 2])', "--compact"]);
    expect(lowered.exitCode).toBe(1);
    expect(lowered.stdout).toBe("");
    expect(lowered.stderr).toContain("function references cannot contain array literals");

    const raised = runCli("to-shorthand", [JSON.stringify({ $fn: ["add", 1, 2] })]);
    expect(raised.exitCode).toBe(1);
    expect(raised.stdout).toBe("");
    expect(raised.stderr).toContain("$fn cannot be an array; use $call/$args for calls");
  });
});

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

describe("jfn eval canonical JSON input", () => {
  test("evaluates a canonical expression", () => {
    const source = JSON.stringify({ $call: "add", $args: [1, 2] });
    const result = runEval(["--json-input", source, "--compact"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("3");
  });

  test("applies arguments to a canonical function", () => {
    const source = JSON.stringify({
      $params: ["value"],
      $return: { $call: "mul", $args: [{ $var: "value" }, { $var: "value" }] },
    });
    const result = runEval(["--json-input", source, "--args", "[9]", "--compact"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("81");
  });

  test("reports malformed canonical JSON as JSON input", () => {
    const result = runEval(["--json-input", '{"$call":']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("jfn: invalid JSON input:");
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

describe("jfn eval execution limits", () => {
  const recursive = "(() => go(300) where { go: (n) => if n <= 0 then 0 else go(n - 1) })()";

  test("allows the call-depth limit to be raised", () => {
    const defaultResult = runEval([recursive]);
    const raisedResult = runEval([recursive, "--max-call-depth", "1024", "--compact"]);

    expect(defaultResult.exitCode).toBe(1);
    expect(defaultResult.stderr).toContain("Maximum call depth of 256 exceeded");
    expect(raisedResult.exitCode).toBe(0);
    expect(raisedResult.stderr).toBe("");
    expect(raisedResult.stdout.trim()).toBe("0");
  });

  test.each([
    {
      option: "--max-call-depth",
      value: "2",
      source: "(() => go(3) where { go: (n) => if n <= 0 then 0 else go(n - 1) })()",
      error: "Maximum call depth of 2 exceeded",
    },
    {
      option: "--max-fuel",
      value: "0",
      source: "1",
      error: "Maximum fuel limit of 0 exceeded",
    },
    {
      option: "--max-value-size",
      value: "2",
      source: "range(3)",
      error: "Maximum value size of 2 exceeded",
    },
  ])("enforces $option", ({ option, value, source, error }) => {
    const result = runEval([source, option, value]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(error);
  });

  test.each(["-1", "1.5", "nope", "9007199254740992"])(
    "rejects invalid execution limit %s",
    (value) => {
      const result = runEval(["1", "--max-fuel", value]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("jfn: invalid --max-fuel: expected a non-negative integer\n");
    },
  );
});

describe("jfn eval contract modes", () => {
  test("executes a direct contract entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-direct-entry-"));
    const contractPath = join(directory, "contract.json");
    writeFileSync(
      contractPath,
      JSON.stringify({
        version: 1,
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
      const result = runEval(["--contract", contractPath, "{ main: () => 42 }", "--compact"]);
      const canonicalResult = runEval([
        "--contract",
        contractPath,
        "--json-input",
        JSON.stringify({ main: { $params: [], $return: 42 } }),
        "--compact",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("42");
      expect(canonicalResult.exitCode).toBe(0);
      expect(canonicalResult.stderr).toBe("");
      expect(canonicalResult.stdout.trim()).toBe("42");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports the nested instance path for invalid contract entry arguments", () => {
    const result = runEval([
      "--file",
      join(examples, "dungeon.jfn"),
      "--contract",
      join(examples, "dungeon.contract.json"),
      "--args",
      '[{"at":"attic","held":[]}]',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'entry "play" arguments contract failed at args[0].at: "attic" is not one of ["cell","hall","gate"]',
    );
    expect(result.stderr).not.toContain('"prefixItems"');
  });

  test("distinguishes the authoritative entry from a development function", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-contract-"));
    const contractPath = join(directory, "contract.json");
    writeFileSync(
      contractPath,
      JSON.stringify({
        version: 1,
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
      const production = runEval(["--contract", contractPath, module, "--compact"]);
      const development = runEval([
        "--contract",
        contractPath,
        "--function",
        "demo",
        module,
        "--compact",
      ]);
      const limitedProduction = runEval(["--contract", contractPath, "--max-fuel", "0", module]);
      const limitedDevelopment = runEval([
        "--contract",
        contractPath,
        "--function",
        "demo",
        "--max-fuel",
        "0",
        module,
      ]);

      expect(production.exitCode).toBe(0);
      expect(production.stdout.trim()).toBe("7");
      expect(development.exitCode).toBe(0);
      expect(development.stdout.trim()).toBe("9");
      expect(limitedProduction.exitCode).toBe(1);
      expect(limitedProduction.stderr).toContain("Maximum fuel limit of 0 exceeded");
      expect(limitedDevelopment.exitCode).toBe(1);
      expect(limitedDevelopment.stderr).toContain("Maximum fuel limit of 0 exceeded");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("--function bypasses production entry validation and invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-development-function-"));
    const contractPath = join(directory, "contract.json");
    writeFileSync(
      contractPath,
      JSON.stringify({
        version: 1,
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
      const production = runEval(["--contract", contractPath, module, "--compact"]);
      const development = runEval([
        "--contract",
        contractPath,
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

  test("enforces contract entry ranges while preserving optional omission", () => {
    const directory = mkdtempSync(join(tmpdir(), "json-fn-eval-entry-optionals-"));
    const contractPath = join(directory, "contract.json");
    const module =
      "{ main: (required, optional?, defaulted = 7) => pure([required, optional, defaulted]) }";

    try {
      writeFileSync(
        contractPath,
        JSON.stringify({
          version: 1,
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
          "--contract",
          contractPath,
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
          "--contract",
          contractPath,
          "--args",
          JSON.stringify(args),
          module,
        ]);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain('entry "main" arguments contract failed');
      }

      writeFileSync(
        contractPath,
        JSON.stringify({
          version: 1,
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
          "--contract",
          contractPath,
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
        "--contract",
        contractPath,
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

  test("development-evaluates a named function without a contract", () => {
    const result = runEval([
      "--function",
      "square",
      "--args",
      "[9]",
      "{ square: (value) => value * value }",
      "--compact",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("81");
  });

  test("development-evaluates a typed example without a contract", () => {
    const result = runEval([
      "--file",
      join(examples, "pipeline.jfn"),
      "--function",
      "demo",
      "--compact",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["result", "sum", "report"]);
  });

  test("--function requires module input", () => {
    const result = runEval(["--function", "demo", "1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--function requires module input");
  });
});
