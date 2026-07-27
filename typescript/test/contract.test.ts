import { describe, expect, test } from "bun:test";
import {
  DuplicateCallableContractError,
  DuplicateDefinitionError,
  EnvironmentContractValidationError,
  ExternalFunctionError,
  ModuleLinkError,
  ReservedDefinitionError,
  RuntimeContractError,
  ReservedAdapterAliasError,
  RunOptionsValidationError,
  UnhandledEffectError,
  checkModule,
  createStdlib,
  loadBuiltinTable,
  mergeCallableTables,
  parseShorthand,
  analyzeDeploymentCapabilities,
  prepareDeployment,
  runTask as runPreparedTask,
  validateEnvironmentContract,
  type EnvironmentContract,
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

function contract(overrides: Partial<EnvironmentContract> = {}): EnvironmentContract {
  return {
    version: 1,
    functions: {},
    effects: {},
    entry: { name: "main", required: [], optional: [], returns: { task: I } },
    ...overrides,
  };
}

function module(source: string): Record<string, JSONType> {
  return parseShorthand(source) as Record<string, JSONType>;
}

function runTask(
  mod: Record<string, JSONType>,
  contract: EnvironmentContract,
  args: JSONType[],
  host: { registry: Record<string, any>; capabilities: Record<string, any> },
) {
  const functions = Object.fromEntries(
    Object.keys(contract.functions ?? {}).map((name) => [name, host.registry[name]]),
  );
  const effects = Object.keys(host.capabilities);
  return runPreparedTask(
    prepareDeployment({
      module: mod,
      contract,
      profile: { version: 1, mode: "live", effects },
      adapter: { functions, effects: host.capabilities },
    }),
    args,
  );
}

describe("contract validation and composition", () => {
  test("reserves Task across contract and canonical module definitions", () => {
    expect(() => validateEnvironmentContract(contract({ $defs: { Task: true } }))).toThrow(
      EnvironmentContractValidationError,
    );
    expect(() =>
      checkModule(
        {
          $types: { Task: true },
          main: { $params: [], $return: { $call: "pure", $args: [1] } },
        },
        loadBuiltinTable(),
        { contract: contract() },
      ),
    ).toThrow(ReservedDefinitionError);
  });

  test("validates all contracts against the shared definition pool", () => {
    const env = contract({
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
    expect(() => validateEnvironmentContract(env)).not.toThrow();
  });

  test("reports malformed contract paths", () => {
    expect(() =>
      validateEnvironmentContract({
        functions: {},
        effects: {},
        entry: {
          name: "main",
          required: [{ $ref: "#/$defs/Missing" }],
          optional: [],
          returns: true,
        },
      }),
    ).toThrow(EnvironmentContractValidationError);
  });

  test("rejects callable collisions instead of overriding core contracts", () => {
    expect(() =>
      mergeCallableTables(loadBuiltinTable(), contract({ functions: { map: { signatures: [] } } })),
    ).toThrow(DuplicateCallableContractError);
  });

  test("rejects definition collisions across builtin, contract, and module sources", () => {
    expect(() => validateEnvironmentContract(contract({ $defs: { Match: I } }))).toThrow(
      EnvironmentContractValidationError,
    );
    expect(() =>
      checkModule(
        {
          $types: { Match: I },
          main: { $params: [], $return: { $call: "pure", $args: [1] } },
        },
        loadBuiltinTable(),
        { contract: contract() },
      ),
    ).toThrow(DuplicateDefinitionError);
  });

  test("rejects effect names that conflict with namespace prefixes", () => {
    expect(() =>
      validateEnvironmentContract(
        contract({
          effects: {
            sensor: { params: [], returns: I },
            "sensor.read": { params: [], returns: I },
          },
        }),
      ),
    ).toThrow('effect name conflicts with namespace prefix "sensor"');
  });
});

describe("contract checker integration", () => {
  const builtins = loadBuiltinTable();

  test("injects the contract entry signature into normal body checking", () => {
    const env = contract({
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
    expect(checkModule(mod, builtins, { contract: env })).toEqual([]);
  });

  test("rejects an entry body whose parameters do not match the injected signature", () => {
    const env = contract({
      entry: { name: "main", required: [I], optional: [], returns: { task: I } },
    });
    const mod = {
      main: {
        $params: [],
        $return: { $call: "pure", $args: [1] },
      },
    } as Record<string, JSONType>;

    expect(checkModule(mod, builtins, { contract: env })).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: ["main", "$params"],
        message:
          "Contextual signature expects 1 required parameter(s), 0 optional parameter(s), and no rest parameter; body declares 0 required parameter(s), 0 optional parameter(s), and no rest parameter.",
      }),
    );
  });

  test("rejects malformed entry parameters before injected body checking", () => {
    const env = contract({
      entry: { name: "main", required: [I], optional: [], returns: { task: I } },
    });
    const mod = {
      main: {
        $params: [{ $param: "value" }],
        $return: { $var: "missing" },
      },
    } as Record<string, JSONType>;

    expect(checkModule(mod, builtins, { contract: env })).toEqual([
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
      checkModule(mod, builtins, { contract: contract() }).some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.path.join(".") === "main.$return",
      ),
    ).toBe(true);
  });

  test("checks direct and task entry return modes distinctly", () => {
    const direct = contract({
      entry: { name: "main", required: [], optional: [], returns: I },
    });

    expect(checkModule(module("main: () => 42"), builtins, { contract: direct })).toEqual([]);
    expect(
      checkModule(module("main: () => pure(42)"), builtins, {
        contract: direct,
      }).some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.path.join(".") === "main.$return",
      ),
    ).toBe(true);
    expect(
      checkModule(module("main: () => 42"), builtins, {
        contract: contract(),
      }).some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.path.join(".") === "main.$return",
      ),
    ).toBe(true);
  });

  test("types manifest-derived effect calls through the injected namespace", () => {
    const env = contract({
      effects: {
        "sensor.read": { params: [], returns: I },
      },
    });

    expect(
      checkModule(module("main: () => effects.sensor.read()"), builtins, {
        contract: env,
      }),
    ).toEqual([]);
  });

  test("preserves effect completion types through explicitly typed helpers", () => {
    const env = contract({
      effects: {
        "sensor.read": { params: [], returns: I },
      },
    });
    const mod = module(`
      read: () -> Task<integer> => effects.sensor.read(),
      main: () => read()
    `);

    expect(checkModule(mod, builtins, { contract: env })).toEqual([]);
  });

  test("checks recursive helper completion types through their eager signatures", () => {
    const mod = module(`
      loop: (fuel: integer) -> Task<integer> =>
        if fuel <= 0 then pure(0) else loop(fuel - 1),
      main: () => loop(2)
    `);

    expect(checkModule(mod, builtins, { contract: contract() })).toEqual([]);
  });

  test("rejects a helper body with the wrong declared completion type", () => {
    const mod = module(`
      wrong: () -> Task<integer> => pure("wrong"),
      main: () => wrong()
    `);

    expect(
      checkModule(mod, builtins, { contract: contract() }).some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.path.join(".") === "wrong.$return",
      ),
    ).toBe(true);
  });

  test("checks generated effect-call arguments against the manifest", () => {
    const env = contract({
      effects: {
        log: { params: [I], returns: { type: "null" } },
      },
      entry: { name: "main", required: [], optional: [], returns: { task: { type: "null" } } },
    });

    expect(
      checkModule(module('main: () => effects.log("wrong")'), builtins, {
        contract: env,
      }).some((diagnostic) => diagnostic.severity === "error"),
    ).toBe(true);
  });

  test("contextually types annotated handler clauses from the contract", () => {
    const env = contract({
      effects: {
        log: { params: [S], returns: { type: "null" } },
      },
    });
    const mod = module(`
      interpret: (task: Task<integer>) -> integer => handle task -> integer with {
        log: (message, resume) => resume(null) + length(message),
        return: (value) => value + 1
      },
      main: () => pure(1)
    `);

    expect(checkModule(mod, builtins, { contract: env })).toEqual([]);
  });

  test("checks handler parameters, resume input, and clause results", () => {
    const env = contract({
      effects: {
        log: { params: [S], returns: { type: "null" } },
      },
    });
    const mod = module(`
      interpret: (task: Task<integer>) -> integer => handle task -> integer with {
        log: (message, resume) => resume("wrong") + message,
        return: (value) => "wrong"
      },
      main: () => pure(1)
    `);
    const diagnostics = checkModule(mod, builtins, { contract: env });

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
    expect(() =>
      checkModule(module("effects: {}, main: () => pure(1)"), builtins, {
        contract: contract(),
      }),
    ).toThrow(ModuleLinkError);
  });
});

describe("contract runtime integration", () => {
  test("executes and validates a direct entry without task stepping", async () => {
    const env = contract({
      entry: { name: "main", required: [], optional: [], returns: I },
    });
    const host = { registry: createStdlib(), capabilities: {} };

    expect(checkModule(module("main: () => 42"), loadBuiltinTable(), { contract: env })).toEqual(
      [],
    );
    expect(await runTask(module("main: () => 42"), env, [], host)).toBe(42);
    expect(runTask(module('main: () => "wrong"'), env, [], host)).rejects.toThrow(
      RuntimeContractError,
    );
  });

  test("does not auto-run task-shaped data returned by a direct entry", async () => {
    const env = contract({
      entry: { name: "main", required: [], optional: [], returns: true },
    });

    expect(
      await runTask(module("main: () => pure(42)"), env, [], {
        registry: createStdlib(),
        capabilities: {},
      }),
    ).toEqual({ "@task": "pure", value: 42 });
  });

  test("supports required and optional arguments for direct entries", async () => {
    const env = contract({
      entry: {
        name: "main",
        required: [I],
        optional: [I],
        returns: { type: "array" },
      },
    });
    const mod = module("main: (required, optional?) => [required, optional]");
    const host = { registry: createStdlib(), capabilities: {} };

    expect(checkModule(mod, loadBuiltinTable(), { contract: env })).toEqual([]);
    expect(await runTask(mod, env, [1], host)).toEqual([1, null]);
    expect(await runTask(mod, env, [1, 2], host)).toEqual([1, 2]);
  });

  test("returns ordinary object data from a direct entry", async () => {
    const resultSchema: EnvironmentContract["entry"]["returns"] = {
      type: "object",
      properties: { answer: I },
      required: ["answer"],
      additionalProperties: false,
    };
    const env = contract({
      entry: { name: "main", required: [], optional: [], returns: resultSchema },
    });
    const mod = module("main: () => { answer: 42 }");

    expect(checkModule(mod, loadBuiltinTable(), { contract: env })).toEqual([]);
    expect(await runTask(mod, env, [], { registry: createStdlib(), capabilities: {} })).toEqual({
      answer: 42,
    });
  });

  test("rejects invalid initial entry arguments before evaluation", () => {
    const env = contract({
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
    const env = contract({
      entry: {
        name: "main",
        required: [I],
        optional: [I, I],
        returns: { task: true },
      },
    });
    const mod = module(`
      main: (required, optional?, defaulted = 7) =>
        pure([required, optional, defaulted])
    `);
    const host = { registry: createStdlib(), capabilities: {} };

    expect(checkModule(mod, loadBuiltinTable(), { contract: env })).toEqual([]);
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
    const env = contract({
      entry: {
        name: "main",
        required: [],
        optional: [nullableInteger],
        returns: { task: nullableInteger },
      },
    });
    const mod = module("main: (value?) => pure(value)");
    const host = { registry: createStdlib(), capabilities: {} };

    expect(checkModule(mod, loadBuiltinTable(), { contract: env })).toEqual([]);
    expect(await runTask(mod, env, [], host)).toBeNull();
    expect(await runTask(mod, env, [3], host)).toBe(3);
    expect(await runTask(mod, env, [null], host)).toBeNull();
    expect(runTask(mod, env, ["wrong"], host)).rejects.toThrow(RuntimeContractError);
  });

  test("validates direct functions and entry arguments/results", async () => {
    const env = contract({
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

  test("erases generic contract variables for runtime host-function wrapping", async () => {
    const generic = contract({
      functions: {
        identity: {
          signatures: [
            {
              typeParams: ["T"],
              required: [{ $tvar: "T" }],
              optional: [],
              returns: { $tvar: "T" },
            },
          ],
        },
      },
      entry: { name: "main", required: [], optional: [], returns: { task: true } },
    });
    const mod = module("main: () => pure(identity({ ok: true }))");
    const value = await runTask(mod, generic, [], {
      registry: { ...createStdlib(), identity: (input: JSONType) => input },
      capabilities: {},
    });

    expect(value).toEqual({ ok: true });
  });

  test("rejects bad host-function results at the boundary", async () => {
    const env = contract({
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

  test("keeps adapter aliases private while contract wrappers remain callable", async () => {
    const env = contract({
      functions: {
        inc: { signatures: [{ required: [I], optional: [], returns: I }] },
      },
      entry: { name: "main", required: [S], optional: [], returns: { task: I } },
    });
    const host = {
      registry: { ...createStdlib(), inc: (value: number) => value + 1 },
      capabilities: {},
    };

    expect(await runTask(module("main: (_name) => pure(inc(1))"), env, ["inc"], host)).toBe(2);
    await expect(
      runTask(module("main: (name) => pure(name(1))"), env, ["@adapter:inc"], host),
    ).rejects.toBeInstanceOf(ReservedAdapterAliasError);
  });

  test("surfaces thrown adapter functions as typed external errors in live mode", async () => {
    const env = contract({
      functions: {
        explode: { signatures: [{ required: [], optional: [], returns: I }] },
      },
    });
    await expect(
      runTask(module("main: () => pure(explode())"), env, [], {
        registry: {
          ...createStdlib(),
          explode: () => {
            throw new Error("boom");
          },
        },
        capabilities: {},
      }),
    ).rejects.toBeInstanceOf(ExternalFunctionError);
  });

  test("allows contract effects omitted from the live profile", async () => {
    const env = contract({
      effects: { read: { params: [], returns: I } },
    });
    const mod = {
      main: body(
        [],
        { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
        { $call: "pure", $args: [1] },
      ),
    } as Record<string, JSONType>;
    expect(await runTask(mod, env, [], { registry: createStdlib(), capabilities: {} })).toBe(1);
  });

  test("allows guest handlers to consume effects omitted from the live profile", async () => {
    const env = contract({
      effects: { read: { params: [], returns: I } },
    });
    const mod = module(`
      main: () => pure(handle effects.read() with {
        read: (resume) => resume(7)
      })
    `);
    expect(await runTask(mod, env, [], { registry: createStdlib(), capabilities: {} })).toBe(7);
  });

  test("throws when an omitted live effect escapes guest handlers", async () => {
    const env = contract({
      effects: { read: { params: [], returns: I } },
    });
    await expect(
      runTask(module("main: () => effects.read()"), env, [], {
        registry: createStdlib(),
        capabilities: {},
      }),
    ).rejects.toBeInstanceOf(UnhandledEffectError);
  });

  test("does not allow run options to override portable profile limits", () => {
    const deployment = prepareDeployment({
      module: module("main: () => pure(1)"),
      contract: contract(),
      profile: { version: 1, mode: "live", effects: [], limits: { maxFuel: 100 } },
      adapter: { functions: {}, effects: {} },
    });
    expect(() => runPreparedTask(deployment, [], { maxFuel: 1000 } as never)).toThrow(
      RunOptionsValidationError,
    );
  });

  test("rejects adapter functions that have no callable contract", () => {
    const mod = {
      main: body(
        [],
        { required: [], optional: [], returns: { $ref: "#/$defs/Task" } },
        { $call: "pure", $args: [1] },
      ),
    } as Record<string, JSONType>;
    expect(() =>
      prepareDeployment({
        module: mod,
        contract: contract(),
        profile: { version: 1, mode: "live", effects: [] },
        adapter: { functions: { accidental: () => null }, effects: {} },
      }),
    ).toThrow('adapter.functions.accidental: implementation has no contract function "accidental"');
  });

  test("runs a qualified effect when a direct function has the same name", async () => {
    let directCalled = false;
    const env = contract({
      functions: {
        ping: { signatures: [{ required: [], optional: [], returns: I }] },
      },
      effects: {
        ping: { params: [], returns: I },
      },
    });

    const result = await runTask(module("main: () => effects.ping()"), env, [], {
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
      runTask(module("effects: {}, main: () => pure(1)"), contract(), [], {
        registry: createStdlib(),
        capabilities: {},
      }),
    ).toThrow('"effects" is reserved for contract-declared effects');
  });
});

describe("contract capability admission", () => {
  const env = contract({
    effects: {
      "sensor.read": { params: [], returns: I },
      log: { params: [S], returns: { type: "null" } },
    },
  });

  test("collects only statically referenced qualified effects", () => {
    const mod = module('main: () => effects.sensor.read(), helper: () => pure("unused")');
    expect(
      analyzeDeploymentCapabilities({
        module: mod,
        contract: env,
        profile: { version: 1, mode: "live", effects: ["sensor.read"] },
      }),
    ).toEqual({
      possibleNames: ["sensor.read"],
      dynamic: false,
      profileBindings: ["sensor.read"],
      uncovered: [],
    });
  });

  test("marks computed effects access as dynamic", () => {
    const mod = module("main: (name) => effects[name]()");
    expect(
      analyzeDeploymentCapabilities({
        module: mod,
        contract: env,
        profile: { version: 1, mode: "live", effects: [] },
      }),
    ).toEqual({
      possibleNames: [],
      dynamic: true,
      profileBindings: [],
      uncovered: ["log", "sensor.read"],
    });
  });
});
