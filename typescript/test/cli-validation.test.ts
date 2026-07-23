import { describe, expect, test } from "bun:test";
import { join } from "path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const examples = join(import.meta.dir, "../../examples");

function run(command: string, args: string[], stdin?: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, command, ...args],
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("jfn portable artifact validation", () => {
  test("validates a contract from standard file input", () => {
    const result = run("validate-contract", ["--file", join(examples, "thermostat.contract.json")]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Valid contract.\n",
      stderr: "",
    });
  });

  test("validates a profile from stdin against its contract", async () => {
    const profile = await Bun.file(join(examples, "thermostat.profile.json")).text();
    const result = run(
      "validate-profile",
      ["--contract", join(examples, "thermostat.contract.json"), "-"],
      profile,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Valid deployment profile.\n",
      stderr: "",
    });
  });

  test("reports profile selections absent from the contract", () => {
    const result = run(
      "validate-profile",
      ["--contract", join(examples, "orbital-traffic.contract.json")],
      '{"version":1,"mode":"live","effects":["network.send"]}',
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('effect "network.send" is not declared by the contract');
  });
});
