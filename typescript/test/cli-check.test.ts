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

describe("jfn check source positions", () => {
  test("shorthand module diagnostics carry (at line:col) source positions", () => {
    const module = 'a: 1\nf: () -> string => "x" ++ str(a) ++ missing(a)';
    const result = runCheck([module]);
    expect(result.exitCode).toBe(1);
    // `missing(a)` starts at line 2, column 37.
    expect(result.stdout).toContain(
      'error: f.$return.$args[2]: Unknown function "missing". (at 2:37)',
    );
  });

  test("--file prefixes positions with the file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-fn-check-positions-"));
    const path = join(dir, "module.jfn");
    try {
      writeFileSync(path, "f: () -> integer => nope(1)\n");
      const result = runCheck(["--file", path]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`(at ${path}:1:21)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json-diagnostics includes line/col fields for shorthand input", () => {
    const result = runCheck(["--json-diagnostics", "-c", "f: () -> integer => nope(1)"]);
    expect(result.exitCode).toBe(1);
    const diags = JSON.parse(result.stdout) as { line?: number; col?: number }[];
    expect(diags[0]!.line).toBe(1);
    expect(diags[0]!.col).toBe(21);
  });

  test("canonical JSON input reports paths without source positions", () => {
    const result = runCheck(["--expr", "--json", asJsonArg({ $call: "missing", $args: [] })]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('error: <root>: Unknown function "missing".');
    expect(result.stdout).not.toContain("(at ");
  });

  test("--json-input is accepted as an alias for --json", () => {
    const result = runCheck(["--expr", "--json-input", asJsonArg({ $call: "add", $args: [1, 2] })]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No type errors.");
  });
});

describe("jfn positional file-path hint", () => {
  test("a positional argument naming an existing file suggests --file", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-fn-path-hint-"));
    const path = join(dir, "module.jfn");
    try {
      writeFileSync(path, "f: () -> integer => 1\n");
      const positional = runCheck([path]);
      expect(positional.exitCode).toBe(1);
      expect(positional.stderr).toContain(`did you mean --file ${path}?`);

      const viaFile = runCheck(["--file", path]);
      expect(viaFile.exitCode).toBe(0);
      expect(viaFile.stdout).toContain("No type errors.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("jfn check coverage reporting", () => {
  test("degradation reports partial coverage but exits zero by default", () => {
    const result = runCheck(["--expr", "--json", asJsonArg({ $var: "missing" })]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'info: <root>: expression degraded to `any` because variable "missing" is unresolved.',
    );
    expect(result.stdout).toContain("0 errors.");
    expect(result.stdout).toContain("Type coverage: incomplete (1 dynamic degradation site).");
  });

  test("--require-full-coverage makes information diagnostics fail the command", () => {
    const result = runCheck([
      "--expr",
      "--json",
      "--require-full-coverage",
      asJsonArg({ $var: "missing" }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("0 errors.");
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
    expect(withoutBuiltins.stdout).toContain('error: <root>: Unknown function "add".');
    expect(withoutBuiltins.stdout).toContain("Type coverage: complete");
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
        "main: (required, optional?, defaulted = 7) => pure([required, optional, defaulted])",
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
