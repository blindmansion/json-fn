import { describe, expect, test } from "bun:test";
import {
  callProgram,
  checkModule,
  createStdlib,
  linkModule,
  loadBuiltinTable,
  loadEnvironmentContract,
  parseShorthand,
  type JSONType,
} from "../src";
import { runOrchestrationExample } from "../examples/durable-orchestration/run";

const orchestrationDirectory = `${import.meta.dir}/../examples/durable-orchestration`;
const testExamplesDirectory = `${import.meta.dir}/examples`;

async function loadModule(path: string): Promise<Record<string, JSONType>> {
  return parseShorthand(await Bun.file(path).text()) as Record<string, JSONType>;
}

describe("realistic test examples", () => {
  test("durable orchestration agrees with an in-language handler oracle", async () => {
    const builtins = loadBuiltinTable();
    const contract = loadEnvironmentContract(
      `${orchestrationDirectory}/orchestration.contract.json`,
      builtins,
    );
    const workflow = await loadModule(`${orchestrationDirectory}/orchestration.jfn`);
    const oracleProgram = await loadModule(
      `${testExamplesDirectory}/durable-orchestration-oracle.jfn`,
    );
    const interpretedWorkflow = { ...workflow, ...oracleProgram };
    expect(checkModule(interpretedWorkflow, builtins, { contract })).toEqual([]);
    const oracle = linkModule({
      module: interpretedWorkflow,
      builtins,
      contract,
    });
    const registry = createStdlib();

    const task = callProgram(
      oracle.module,
      "workflow",
      [],
      registry,
      undefined,
      oracle.definitionSources,
    );
    const oracleRun = callProgram(
      oracle.module,
      "interpret",
      [task],
      registry,
      undefined,
      oracle.definitionSources,
    ) as { report: JSONType; transcript: string[] };
    const durableRun = await runOrchestrationExample();

    expect(durableRun.result).toEqual(oracleRun.report);
    expect(oracleRun.transcript).toEqual([
      "log starting sequential pipeline",
      "spawn research",
      "await research",
      "spawn summarize",
      "await summarize",
      "log spawning fan-out group",
      "spawn alpha",
      "spawn broken",
      "spawn bravo",
      "awaitAll",
      "awaitAll",
      "spawn fast",
      "spawn slow",
      "awaitAny",
      "log workflow complete",
    ]);
    expect(durableRun.staleDeliveries).toBe(3);
  });
});
