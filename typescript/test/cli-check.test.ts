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

test("jfn check narrows nullable values through equality with null", () => {
  const modules = [
    "guard: (x: integer | null) -> integer => if x != null then x else 0",
    "guard: (x: integer | null) -> integer => if x == null then 0 else x",
    "guard: (x: integer | null) -> integer => if null != x then x else 0",
    "guard: (x?: integer) -> integer => cond { x == null: 0, else: x }",
    "guard: (x: integer | null) -> integer => match x { null: 0, else: x }",
    "guard: (x: integer | null) -> integer => if x != null && x > 0 then x else 0",
    "guard: (x: integer | null) -> integer => if x == null || x > 0 then 1 else 0",
  ];

  for (const module of modules) {
    const result = runCheck([module]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No type errors.");
    expect(result.stdout).toContain("Type coverage: complete");
  }
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

describe("jfn check unknown function names", () => {
  test("rejects unknown and typo-like builtin names in expression position", () => {
    for (const name of ["nonexistent", "len", "first"]) {
      const result = runCheck(["--expr", `${name}(1)`]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`error: <root>: Unknown function "${name}".`);
      expect(result.stdout).toContain("1 error.");
      expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
    }
  });

  test("reports the unknown function without a downstream return mismatch", () => {
    const result = runCheck(["f: () -> integer => nonexistent(1)"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('error: f.$return: Unknown function "nonexistent".');
    expect(result.stdout).toContain("1 error.");
    expect(result.stdout).not.toContain("is not assignable");
  });
});

describe("jfn check builtin function references", () => {
  test("checks explicit, bare, overloaded, and generic builtin callbacks with full coverage", () => {
    const modules = [
      'f: () -> string[] => map(&upper, ["a", "b"])',
      'f: () -> string[] => map(upper, ["a", "b"])',
      "f: (xss: string[][]) -> integer[] => map(&length, xss)",
      "f: (xss: integer[][]) -> (integer | null)[] => map(&head, xss)",
    ];

    for (const module of modules) {
      const result = runCheck([module]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("No type errors.");
      expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
    }
  });

  test("rejects a builtin callback whose overloads cannot accept the mapped item", () => {
    const result = runCheck(["f: () -> integer[] => map(&length, [1, 2])"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("error: f.$return.$args[0]:");
    expect(result.stdout).toContain("1 error.");
    expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
  });
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

  test("spread-call degradation explains strict returns and supports an explicit boundary", () => {
    const module =
      "sum: (a: integer, b: integer) -> integer => a + b\n" +
      "run: (xs: integer[]) -> integer => sum(...xs)";

    const strictReturn = runCheck([module]);
    expect(strictReturn.exitCode).toBe(1);
    expect(strictReturn.stdout).toContain(
      'info: run.$return: expression degraded to `any` because callable rule "apply" has no precise return type.',
    );
    expect(strictReturn.stdout).toContain(
      'error: run.$return: any is not assignable to {"type":"integer"}.',
    );
    expect(strictReturn.stdout).toContain(
      "use `checked as T` for an intentional runtime-checked boundary",
    );

    const ascribedModule = module.replace("sum(...xs)", "sum(...xs) checked as integer");
    const ascribed = runCheck([ascribedModule]);
    expect(ascribed.exitCode).toBe(0);
    expect(ascribed.stdout).toContain("0 errors.");
    expect(ascribed.stdout).toContain("Type coverage: incomplete (1 dynamic degradation site).");

    const fullCoverage = runCheck(["--require-full-coverage", ascribedModule]);
    expect(fullCoverage.exitCode).toBe(1);
    expect(fullCoverage.stdout).toContain("0 errors.");
  });

  test("unknown names are errors independently of --require-full-coverage", () => {
    const result = runCheck([
      "--expr",
      "--json",
      "--require-full-coverage",
      asJsonArg({ $call: "missing", $args: [] }),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('error: <root>: Unknown function "missing".');
    expect(result.stdout).toContain("Type coverage: complete (no dynamic degradations).");
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
