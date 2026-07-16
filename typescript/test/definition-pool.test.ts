import { describe, expect, test } from "bun:test";
import {
  callFunction,
  callProgram,
  createStdlib,
  mergeDefinitionPools,
  prepareProgram,
  type DefinitionPool,
  type JSONType,
} from "../src";
import { loadBuiltinTable } from "../src/builtins";
import { checkModule } from "../src/check/module";

const stdlib = createStdlib();
const layeredRef = { $ref: "#/$defs/Layered" };

function handledResult(value: JSONType, schema: JSONType = layeredRef): JSONType {
  return {
    $call: "handle",
    $args: [{ $call: "pure", $args: [value] }, {}, { $raw: schema }],
  };
}

function runtimeModule(value: JSONType, types?: DefinitionPool): Record<string, JSONType> {
  return {
    ...(types === undefined ? {} : { $types: types }),
    main: { $return: handledResult(value) },
  };
}

describe("shared definition pool", () => {
  test("merges builtin, environment, and module definitions in precedence order", () => {
    expect(
      mergeDefinitionPools(
        {
          builtinDefs: { Shared: { const: "builtin" }, BuiltinOnly: { type: "boolean" } },
          environmentDefs: { Shared: { const: "environment" }, EnvironmentOnly: true },
        },
        { Shared: { const: "module" }, ModuleOnly: false },
      ),
    ).toEqual({
      Shared: { const: "module" },
      BuiltinOnly: { type: "boolean" },
      EnvironmentOnly: true,
      ModuleOnly: false,
    });
  });

  test("callFunction runtime contracts can resolve builtin definitions", () => {
    const match = { match: "a", index: 0, groups: [], named: {} };
    const fn = {
      $return: handledResult(match, { $ref: "#/$defs/Match" }),
    };

    expect(
      callFunction(fn, [], stdlib, undefined, {
        builtinDefs: loadBuiltinTable().$defs,
      }),
    ).toEqual(match);
  });

  test("runtime entrypoints apply environment-over-builtin precedence", () => {
    const definitions = {
      builtinDefs: { Layered: { const: "builtin" } },
      environmentDefs: { Layered: { const: "environment" } },
    };
    const module = runtimeModule("environment");

    expect(callProgram(module, "main", [], stdlib, undefined, definitions)).toBe("environment");
    expect(prepareProgram(module, stdlib, undefined, definitions).invokeEntry("main", [])).toBe(
      "environment",
    );
  });

  test("module types override environment and builtin definitions at runtime", () => {
    const definitions = {
      builtinDefs: { Layered: { const: "builtin" } },
      environmentDefs: { Layered: { const: "environment" } },
    };
    const module = runtimeModule("module", { Layered: { const: "module" } });

    expect(callProgram(module, "main", [], stdlib, undefined, definitions)).toBe("module");
  });

  test("checker uses the same module-over-environment-over-builtin precedence", () => {
    const module: Record<string, JSONType> = {
      $types: { Layered: { const: "module" } },
      main: {
        $params: [],
        $sig: { params: [], returns: layeredRef },
        $return: "module",
      },
    };
    const builtins = {
      $defs: { Layered: { const: "builtin" } },
      builtins: {},
    };

    expect(
      checkModule(module, builtins, {
        environmentDefs: { Layered: { const: "environment" } },
      }),
    ).toEqual([]);
  });
});
