import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function runCheck(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, "check", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const asJsonArg = (value: unknown): string => JSON.stringify(value);

test("jfn check accepts shorthand function-body where", () => {
  const result = runCheck(["--expr", "() -> integer => value where { value: 1 }"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("No type errors.");
});

describe("jfn check coverage reporting", () => {
  test("a clean typed module reports full coverage", () => {
    const mod = {
      f: {
        $params: [],
        $sig: { required: [], optional: [], returns: { type: "integer" } },
        $return: 1,
      },
    };
    const result = runCheck(["--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No type errors.");
    expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
  });

  test("degradation reports partial coverage but exits zero by default", () => {
    const result = runCheck(["--expr", "--json", asJsonArg({ $var: "missing" })]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'info: <root>: expression degraded to `any` because variable "missing" is unresolved.',
    );
    expect(result.stdout).toContain("0 errors.");
    expect(result.stdout).toContain("Type coverage: incomplete (1 dynamic degradation site).");
  });

  test("--require-full-coverage exits non-zero on degradation", () => {
    const result = runCheck([
      "--expr",
      "--json",
      "--require-full-coverage",
      asJsonArg({ $call: "missing", $args: [] }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Type coverage: incomplete (1 dynamic degradation site).");
  });

  test("--no-builtins explicitly removes engine callable contracts", () => {
    const expression = asJsonArg({ $call: "add", $args: [1, 2] });
    expect(runCheck(["--expr", "--json", expression]).stdout).toContain("Type coverage: complete");
    const withoutBuiltins = runCheck([
      "--expr",
      "--json",
      "--no-builtins",
      "--require-full-coverage",
      expression,
    ]);
    expect(withoutBuiltins.exitCode).toBe(1);
    expect(withoutBuiltins.stdout).toContain("Type coverage: incomplete");
  });

  test("--allow-untyped-functions remains permissive but reports partial coverage", () => {
    const mod = { f: { $params: [], $return: 1 } };
    const result = runCheck(["--allow-untyped-functions", "--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'info: f: expression degraded to `any` because module function "f" has no declared signature.',
    );
    expect(result.stdout).toContain("Type coverage: incomplete (1 dynamic degradation site).");
  });

  test("named local functions require signatures unless explicitly allowed", () => {
    const expression = "helper() where { helper: () => 1 }";
    const strict = runCheck(["--expr", expression]);
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toContain(
      'error: $let.helper: function binding "helper" must declare a signature',
    );

    const allowed = runCheck(["--expr", "--allow-untyped-functions", expression]);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain(
      'info: $let.helper: expression degraded to `any` because function binding "helper" has no declared signature.',
    );
  });

  test("hard errors still exit non-zero independently of coverage", () => {
    const mod = { f: { $params: [], $return: 1 } };
    const result = runCheck(["--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("1 error.");
    expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
  });

  test("prints canonical $let binding and $in diagnostic paths", () => {
    const mod = {
      f: {
        $params: [],
        $sig: { required: [], optional: [], returns: { type: "integer" } },
        $return: {
          $let: { bad: { $var: "missing" } },
          $in: { $var: "bad" },
        },
      },
    };
    const result = runCheck(["--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("f.$return.$let.bad");
    expect(result.stdout).toContain("f.$return.$in");
  });

  test("a former narrowable warning is now a hard error (§4.5)", () => {
    // A `number`-typed index into a tuple used to degrade to a runtime-checkable
    // warning; the warning tier is gone, so it now exits non-zero as an error.
    const mod = {
      f: {
        $params: ["i"],
        $sig: { required: [{ type: "number" }], optional: [], returns: true },
        $return: { $get: { $var: "i" }, $from: [1, 2] },
      },
    };
    const result = runCheck(["--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("error:");
    expect(result.stdout).toContain("1 error.");
    expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
  });

  test("--contract preloads host callables and verifies the entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-fn-contract-"));
    const path = join(dir, "contract.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          functions: {
            "host.inc": {
              signatures: [
                {
                  required: [{ type: "integer" }],
                  optional: [],
                  returns: { type: "integer" },
                },
              ],
            },
          },
          effects: {},
          entry: {
            name: "main",
            required: [],
            optional: [],
            returns: { task: { type: "integer" } },
          },
        }),
      );
      const mod = {
        main: {
          $params: [],
          $sig: { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
          $return: {
            $call: "pure",
            $args: [{ $call: "host.inc", $args: [1] }],
          },
        },
      };
      const result = runCheck(["--json", "--contract", path, asJsonArg(mod)]);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("No type errors.");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--contract accepts an entry with optional and defaulted body slots", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-fn-check-entry-optionals-"));
    const path = join(dir, "contract.json");
    try {
      writeFileSync(
        path,
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
      const result = runCheck([
        "--contract",
        path,
        "{ main: (required, optional?, defaulted = 7) => pure([required, optional, defaulted]) }",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        "No type errors.\nType coverage: complete (no dynamic degradations).\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
