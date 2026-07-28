import { expect, test } from "bun:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function runBuiltin(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, "builtin", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("jfn builtin prints overloads and the description", () => {
  const result = runBuiltin(["add"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "add\n  (integer, integer) → integer\n  (number, number) → number\n\nAdd two numbers.\n",
  );
});

test("jfn builtin renders generic signatures", () => {
  const result = runBuiltin(["map"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "map\n  <T, U>((T) → U, T[]) → U[]\n\nTransform each array element with a callback.\n",
  );
});

test("jfn builtin rejects unknown names", () => {
  const result = runBuiltin(["missing"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe('jfn: unknown builtin "missing"\n');
});
