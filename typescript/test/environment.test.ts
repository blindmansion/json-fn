import { describe, expect, test } from "bun:test";
import {
  DuplicateCallableContractError,
  EnvironmentConfigurationError,
  EnvironmentValidationError,
  RuntimeContractError,
  checkModule,
  createStdlib,
  loadBuiltinTable,
  mergeCallableTables,
  runTask,
  validateEnvironment,
  type Environment,
  type JSONType,
} from "../src";

const I = { type: "integer" } as const;
const S = { type: "string" } as const;

function body(
  params: string[],
  signature: { params: JSONType[]; returns: JSONType },
  returns: JSONType,
): JSONType {
  return { $params: params, $sig: signature, $return: returns };
}

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    functions: {},
    effects: {},
    entry: { name: "main", params: [], returns: { task: I } },
    ...overrides,
  };
}

describe("environment validation and composition", () => {
  test("validates all contracts against the shared definition pool", () => {
    const env = environment({
      $defs: { Count: I },
      functions: {
        "host.label": {
          signatures: [
            {
              params: [{ $ref: "#/$defs/Count" }],
              returns: S,
            },
          ],
        },
      },
      entry: {
        name: "main",
        params: [{ $ref: "#/$defs/Count" }],
        returns: { task: { $ref: "#/$defs/Count" } },
      },
    });
    expect(() => validateEnvironment(env, loadBuiltinTable().$defs)).not.toThrow();
  });

  test("reports malformed environment paths", () => {
    expect(() =>
      validateEnvironment({
        functions: {},
        effects: {},
        entry: { name: "main", params: [{ $ref: "#/$defs/Missing" }], returns: true },
      }),
    ).toThrow(EnvironmentValidationError);
  });

  test("rejects callable collisions instead of overriding core contracts", () => {
    expect(() =>
      mergeCallableTables(
        loadBuiltinTable(),
        environment({ functions: { map: { signatures: [] } } }),
      ),
    ).toThrow(DuplicateCallableContractError);
  });
});

describe("environment checker integration", () => {
  const builtins = loadBuiltinTable();

  test("injects the environment entry signature into normal body checking", () => {
    const env = environment({
      functions: {
        "host.inc": { signatures: [{ params: [I], returns: I }] },
      },
    });
    const mod = {
      main: {
        $params: [],
        $return: {
          $call: "pure",
          $args: [{ $call: "host.inc", $args: [1] }],
        },
      },
    } as Record<string, JSONType>;
    expect(checkModule(mod, builtins, { environment: env })).toEqual([]);
  });

  test("rejects an entry body whose parameters do not match the injected signature", () => {
    const env = environment({
      entry: { name: "main", params: [I], returns: { task: I } },
    });
    const mod = {
      main: {
        $params: [],
        $return: { $call: "pure", $args: [1] },
      },
    } as Record<string, JSONType>;

    expect(checkModule(mod, builtins, { environment: env })).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: ["main", "$params"],
        message:
          "Contextual signature expects 1 fixed parameter(s); body declares 0 fixed parameter(s).",
      }),
    );
  });

  test("rejects an entry body with the wrong completion type", () => {
    const mod = {
      main: {
        $params: [],
        $return: { $call: "pure", $args: ["wrong"] },
      },
    } as Record<string, JSONType>;
    expect(
      checkModule(mod, builtins, { environment: environment() }).some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.path.join(".") === "main.$return",
      ),
    ).toBe(true);
  });
});

describe("environment runtime integration", () => {
  test("rejects invalid initial entry arguments before evaluation", () => {
    const env = environment({
      entry: { name: "main", params: [I], returns: { task: I } },
    });
    const mod = {
      main: body(
        ["n"],
        { params: [I], returns: { $ref: "#/$defs/Task" } },
        { $call: "pure", $args: [{ $var: "n" }] },
      ),
    } as Record<string, JSONType>;
    expect(
      runTask(mod, env, ["bad"], {
        registry: createStdlib(),
        capabilities: {},
      }),
    ).rejects.toThrow(RuntimeContractError);
  });

  test("validates direct functions and entry arguments/results", async () => {
    const env = environment({
      functions: {
        "host.inc": { signatures: [{ params: [I], returns: I }] },
      },
    });
    const mod = {
      main: body(
        [],
        { params: [], returns: { $ref: "#/$defs/Task" } },
        {
          $call: "pure",
          $args: [{ $call: "host.inc", $args: [1] }],
        },
      ),
    } as Record<string, JSONType>;

    expect(
      await runTask(mod, env, [], {
        registry: { ...createStdlib(), "host.inc": (n: number) => n + 1 },
        capabilities: {},
      }),
    ).toBe(2);
  });

  test("rejects bad host-function results at the boundary", async () => {
    const env = environment({
      functions: {
        "host.inc": { signatures: [{ params: [I], returns: I }] },
      },
    });
    const mod = {
      main: body(
        [],
        { params: [], returns: { $ref: "#/$defs/Task" } },
        {
          $call: "pure",
          $args: [{ $call: "host.inc", $args: [1] }],
        },
      ),
    } as Record<string, JSONType>;
    expect(
      runTask(mod, env, [], {
        registry: { ...createStdlib(), "host.inc": () => "bad" },
        capabilities: {},
      }),
    ).rejects.toThrow(RuntimeContractError);
  });

  test("requires implementations for every declared host boundary", () => {
    const env = environment({
      effects: { read: { params: [], returns: I } },
    });
    const mod = {
      main: body(
        [],
        { params: [], returns: { $ref: "#/$defs/Task" } },
        { $call: "pure", $args: [1] },
      ),
    } as Record<string, JSONType>;
    expect(() => runTask(mod, env, [], { registry: createStdlib(), capabilities: {} })).toThrow(
      EnvironmentConfigurationError,
    );
  });

  test("rejects runtime functions that have no callable contract", () => {
    const mod = {
      main: body(
        [],
        { params: [], returns: { $ref: "#/$defs/Task" } },
        { $call: "pure", $args: [1] },
      ),
    } as Record<string, JSONType>;
    expect(() =>
      runTask(mod, environment(), [], {
        registry: { ...createStdlib(), accidental: () => null },
        capabilities: {},
      }),
    ).toThrow('runtime function "accidental" has no callable contract');
  });
});
