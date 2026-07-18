import { describe, expect, test } from "bun:test";
import {
  DuplicateCallableContractError,
  EnvironmentConfigurationError,
  EnvironmentValidationError,
  ReservedDefinitionError,
  RuntimeContractError,
  checkModule,
  createStdlib,
  loadBuiltinTable,
  mergeCallableTables,
  parseShorthand,
  requiredCapabilities,
  runTask,
  validateEnvironment,
  type Environment,
  type JSONType,
} from "../src";

const I = { type: "integer" } as const;
const S = { type: "string" } as const;

function body(
  params: string[],
  signature: { required: JSONType[]; optional: JSONType[]; returns: JSONType },
  returns: JSONType,
): JSONType {
  return { $params: params, $sig: signature, $return: returns };
}

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    functions: {},
    effects: {},
    entry: { name: "main", required: [], optional: [], returns: { task: I } },
    ...overrides,
  };
}

function module(source: string): Record<string, JSONType> {
  return parseShorthand(source) as Record<string, JSONType>;
}

describe("environment validation and composition", () => {
  test("reserves Task across environment and canonical module definitions", () => {
    expect(() =>
      validateEnvironment(environment({ $defs: { Task: true } }), loadBuiltinTable().$defs),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      checkModule(
        {
          $types: { Task: true },
          main: { $params: [], $return: { $call: "pure", $args: [1] } },
        },
        loadBuiltinTable(),
        { environment: environment() },
      ),
    ).toThrow(ReservedDefinitionError);
  });

  test("validates all contracts against the shared definition pool", () => {
    const env = environment({
      $defs: { Count: I },
      functions: {
        "host.label": {
          signatures: [
            {
              required: [{ $ref: "#/$defs/Count" }],
              optional: [],
              returns: S,
            },
          ],
        },
      },
      entry: {
        name: "main",
        required: [{ $ref: "#/$defs/Count" }],
        optional: [],
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
        entry: {
          name: "main",
          required: [{ $ref: "#/$defs/Missing" }],
          optional: [],
          returns: true,
        },
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

  test("rejects effect names that conflict with namespace prefixes", () => {
    expect(() =>
      validateEnvironment(
        environment({
          effects: {
            sensor: { params: [], returns: I },
            "sensor.read": { params: [], returns: I },
          },
        }),
      ),
    ).toThrow('effect name conflicts with namespace prefix "sensor"');
  });
});

describe("environment checker integration", () => {
  const builtins = loadBuiltinTable();

  test("injects the environment entry signature into normal body checking", () => {
    const env = environment({
      functions: {
        "host.inc": { signatures: [{ required: [I], optional: [], returns: I }] },
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
      entry: { name: "main", required: [I], optional: [], returns: { task: I } },
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
          "Contextual signature expects 1 required parameter(s), 0 optional parameter(s), and no rest parameter; body declares 0 required parameter(s), 0 optional parameter(s), and no rest parameter.",
      }),
    );
  });

  test("rejects malformed entry parameters before injected body checking", () => {
    const env = environment({
      entry: { name: "main", required: [I], optional: [], returns: { task: I } },
    });
    const mod = {
      main: {
        $params: [{ $param: "value" }],
        $return: { $var: "missing" },
      },
    } as Record<string, JSONType>;

    expect(checkModule(mod, builtins, { environment: env })).toEqual([
      {
        path: ["main", "$params[0]"],
        message: expect.stringContaining("$params[0]: A defaulted parameter must contain exactly"),
        severity: "error",
      },
    ]);
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

  test("types manifest-derived effect calls through the injected namespace", () => {
    const env = environment({
      effects: {
        "sensor.read": { params: [], returns: I },
      },
    });

    expect(
      checkModule(module("{ main: () => effects.sensor.read() }"), builtins, {
        environment: env,
      }),
    ).toEqual([]);
  });

  test("preserves effect completion types through explicitly typed helpers", () => {
    const env = environment({
      effects: {
        "sensor.read": { params: [], returns: I },
      },
    });
    const mod = module(`{
      read: () -> Task<integer> => effects.sensor.read(),
      main: () => read()
    }`);

    expect(checkModule(mod, builtins, { environment: env })).toEqual([]);
  });

  test("checks recursive helper completion types through their eager signatures", () => {
    const mod = module(`{
      loop: (fuel: integer) -> Task<integer> =>
        if fuel <= 0 then pure(0) else loop(fuel - 1),
      main: () => loop(2)
    }`);

    expect(checkModule(mod, builtins, { environment: environment() })).toEqual([]);
  });

  test("rejects a helper body with the wrong declared completion type", () => {
    const mod = module(`{
      wrong: () -> Task<integer> => pure("wrong"),
      main: () => wrong()
    }`);

    expect(
      checkModule(mod, builtins, { environment: environment() }).some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.path.join(".") === "wrong.$return",
      ),
    ).toBe(true);
  });

  test("checks generated effect-call arguments against the manifest", () => {
    const env = environment({
      effects: {
        log: { params: [I], returns: { type: "null" } },
      },
      entry: { name: "main", required: [], optional: [], returns: { task: { type: "null" } } },
    });

    expect(
      checkModule(module('{ main: () => effects.log("wrong") }'), builtins, {
        environment: env,
      }).some((diagnostic) => diagnostic.severity === "error"),
    ).toBe(true);
  });

  test("contextually types annotated handler clauses from the environment", () => {
    const env = environment({
      effects: {
        log: { params: [S], returns: { type: "null" } },
      },
    });
    const mod = module(`{
      interpret: (task: Task<integer>) -> integer => handle task -> integer with {
        log: (message, resume) => resume(null) + length(message),
        return: (value) => value + 1
      },
      main: () => pure(1)
    }`);

    expect(checkModule(mod, builtins, { environment: env })).toEqual([]);
  });

  test("checks handler parameters, resume input, and clause results", () => {
    const env = environment({
      effects: {
        log: { params: [S], returns: { type: "null" } },
      },
    });
    const mod = module(`{
      interpret: (task: Task<integer>) -> integer => handle task -> integer with {
        log: (message, resume) => resume("wrong") + message,
        return: (value) => "wrong"
      },
      main: () => pure(1)
    }`);
    const diagnostics = checkModule(mod, builtins, { environment: env });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: expect.arrayContaining(["log", "$return"]),
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: expect.arrayContaining(["return", "$return"]),
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "info")).toEqual([]);
  });

  test("rejects a guest binding that shadows the injected effects namespace", () => {
    const diagnostics = checkModule(module("{ effects: {}, main: () => pure(1) }"), builtins, {
      environment: environment(),
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        path: ["effects"],
        message: '"effects" is reserved for environment-declared effects',
      }),
    );
  });
});

describe("environment runtime integration", () => {
  test("rejects invalid initial entry arguments before evaluation", () => {
    const env = environment({
      entry: { name: "main", required: [I], optional: [], returns: { task: I } },
    });
    const mod = {
      main: body(
        ["n"],
        { required: [I], optional: [], returns: { $ref: "#/$defs/Task" } },
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

  test("accepts entry arguments from the required count through the optional maximum", async () => {
    const env = environment({
      entry: {
        name: "main",
        required: [I],
        optional: [I, I],
        returns: { task: true },
      },
    });
    const mod = module(`{
      main: (required, optional?, defaulted = 7) =>
        pure([required, optional, defaulted])
    }`);
    const host = { registry: createStdlib(), capabilities: {} };

    expect(checkModule(mod, loadBuiltinTable(), { environment: env })).toEqual([]);
    expect(await runTask(mod, env, [1], host)).toEqual([1, null, 7]);
    expect(await runTask(mod, env, [1, 2], host)).toEqual([1, 2, 7]);
    expect(await runTask(mod, env, [1, 2, 3], host)).toEqual([1, 2, 3]);
    expect(runTask(mod, env, [], host)).rejects.toThrow(RuntimeContractError);
    expect(runTask(mod, env, [1, 2, 3, 4], host)).rejects.toThrow(RuntimeContractError);
    expect(runTask(mod, env, [1, "wrong"], host)).rejects.toThrow(RuntimeContractError);
    expect(runTask(mod, env, [1, null], host)).rejects.toThrow(RuntimeContractError);
  });

  test("validates supplied nullable optional entry arguments without requiring them", async () => {
    const nullableInteger: JSONType = { anyOf: [I, { type: "null" }] };
    const env = environment({
      entry: {
        name: "main",
        required: [],
        optional: [nullableInteger],
        returns: { task: nullableInteger },
      },
    });
    const mod = module("{ main: (value?) => pure(value) }");
    const host = { registry: createStdlib(), capabilities: {} };

    expect(checkModule(mod, loadBuiltinTable(), { environment: env })).toEqual([]);
    expect(await runTask(mod, env, [], host)).toBeNull();
    expect(await runTask(mod, env, [3], host)).toBe(3);
    expect(await runTask(mod, env, [null], host)).toBeNull();
    expect(runTask(mod, env, ["wrong"], host)).rejects.toThrow(RuntimeContractError);
  });

  test("validates direct functions and entry arguments/results", async () => {
    const env = environment({
      functions: {
        "host.inc": { signatures: [{ required: [I], optional: [], returns: I }] },
      },
    });
    const mod = {
      main: body(
        [],
        { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
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
        "host.inc": { signatures: [{ required: [I], optional: [], returns: I }] },
      },
    });
    const mod = {
      main: body(
        [],
        { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
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
        { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
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
        { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
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

  test("runs a qualified effect when a direct function has the same name", async () => {
    let directCalled = false;
    const env = environment({
      functions: {
        ping: { signatures: [{ required: [], optional: [], returns: I }] },
      },
      effects: {
        ping: { params: [], returns: I },
      },
    });

    const result = await runTask(module("{ main: () => effects.ping() }"), env, [], {
      registry: {
        ...createStdlib(),
        ping: () => {
          directCalled = true;
          return 1;
        },
      },
      capabilities: { ping: () => 7 },
    });

    expect(result).toBe(7);
    expect(directCalled).toBe(false);
  });

  test("rejects a runtime module that shadows the effects namespace", () => {
    expect(() =>
      runTask(module("{ effects: {}, main: () => pure(1) }"), environment(), [], {
        registry: createStdlib(),
        capabilities: {},
      }),
    ).toThrow('"effects" is reserved for environment-declared effects');
  });
});

describe("environment capability admission", () => {
  const env = environment({
    effects: {
      "sensor.read": { params: [], returns: I },
      log: { params: [S], returns: { type: "null" } },
    },
  });

  test("collects only statically referenced qualified effects", () => {
    const mod = module('{ main: () => effects.sensor.read(), helper: () => pure("unused") }');
    expect(requiredCapabilities(mod, env)).toEqual({
      names: ["sensor.read"],
      dynamic: false,
    });
  });

  test("marks computed effects access as dynamic", () => {
    const mod = module("{ main: (name) => effects[name]() }");
    expect(requiredCapabilities(mod, env)).toEqual({
      names: [],
      dynamic: true,
    });
  });
});
