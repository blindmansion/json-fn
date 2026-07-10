import { describe, expect, test } from "bun:test";

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

describe("jfn check coverage reporting", () => {
  test("a clean typed module reports full coverage", () => {
    const mod = {
      f: { $params: [], $sig: { params: [], returns: { type: "integer" } }, $return: 1 },
    };
    const result = runCheck(["--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No type errors.");
    expect(result.stdout).toContain("Coverage: fully checked.");
  });

  test("degradation reports partial coverage but exits zero by default", () => {
    const result = runCheck(["--expr", "--json", asJsonArg({ $var: "missing" })]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'info: <root>: expression degraded to `any` because variable "missing" is unresolved.',
    );
    expect(result.stdout).toContain("0 errors, 0 warnings.");
    expect(result.stdout).toContain("Coverage: not fully checked (1 degradation site).");
  });

  test("--require-full-coverage exits non-zero on degradation", () => {
    const result = runCheck([
      "--expr",
      "--json",
      "--require-full-coverage",
      asJsonArg({ $call: "missing", $args: [] }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Coverage: not fully checked (1 degradation site).");
  });

  test("--allow-untyped-functions remains permissive but reports partial coverage", () => {
    const mod = { f: { $params: [], $return: 1 } };
    const result = runCheck(["--allow-untyped-functions", "--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'info: f: expression degraded to `any` because module function "f" has no declared signature.',
    );
    expect(result.stdout).toContain("Coverage: not fully checked (1 degradation site).");
  });

  test("hard errors still exit non-zero independently of coverage", () => {
    const mod = { f: { $params: [], $return: 1 } };
    const result = runCheck(["--json", asJsonArg(mod)]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("1 error, 0 warnings.");
    expect(result.stdout).toContain("Coverage: fully checked.");
  });

  test("--strict remains the warning gate", () => {
    const mod = {
      f: {
        $params: ["i"],
        $sig: { params: [{ type: "number" }], returns: true },
        $return: { $get: { $var: "i" }, $from: [1, 2] },
      },
    };
    const args = ["--json", asJsonArg(mod)];
    const normal = runCheck(args);
    const strict = runCheck(["--strict", ...args]);
    expect(normal.exitCode).toBe(0);
    expect(strict.exitCode).toBe(1);
    expect(normal.stdout).toContain("0 errors, 1 warning.");
    expect(normal.stdout).toContain("Coverage: fully checked.");
  });
});
