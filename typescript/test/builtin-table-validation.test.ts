import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CallableTableValidationError,
  loadBuiltinTable,
  validateCallableTable,
} from "../src/builtins";

const tableWith = (signatures: unknown, defs: Record<string, unknown> = {}, rule?: unknown) => ({
  $defs: defs,
  builtins: { example: { signatures, ...(rule === undefined ? {} : { rule }) } },
});

const signature = {
  required: [{ type: "string" }],
  optional: [],
  returns: { type: "boolean" },
};

function validationError(value: unknown): CallableTableValidationError {
  try {
    validateCallableTable(value);
  } catch (error) {
    expect(error).toBeInstanceOf(CallableTableValidationError);
    return error as CallableTableValidationError;
  }
  throw new Error("expected builtin table validation to fail");
}

describe("builtin table validation", () => {
  test("the canonical builtin table is valid", () => {
    expect(Object.keys(loadBuiltinTable().builtins).length).toBeGreaterThan(0);
  });

  test("the spec-v2 builtin table with metering declarations is valid", () => {
    const path = join(import.meta.dir, "../../spec-v2/builtins/builtins.json");
    expect(Object.keys(loadBuiltinTable(path).builtins).length).toBeGreaterThan(0);
  });

  test("the file loader rejects a malformed table before returning it", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-fn-builtins-"));
    const path = join(dir, "builtins.json");
    try {
      writeFileSync(path, JSON.stringify({ builtins: { bad: [] } }));
      expect(() => loadBuiltinTable(path)).toThrow(CallableTableValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts normalized signature-only and rule-backed entries", () => {
    const value: unknown = {
      $schema: "./builtins.schema.json",
      description: "test table",
      builtins: {
        declarative: { signatures: [signature] },
        special: {
          description: "Handle an effect.",
          category: "effects",
          signatures: [signature],
          rule: "core.handle",
        },
      },
    };
    validateCallableTable(value);
    expect(value.builtins.declarative!.signatures).toHaveLength(1);
  });

  test("rejects malformed table and entry shapes", () => {
    expect(validationError({ $schema: "./other.schema.json", builtins: {} }).path).toBe(
      "table.$schema",
    );
    expect(validationError({}).path).toBe("table.builtins");
    expect(validationError({ builtins: { example: [] } }).path).toBe("table.builtins.example");
    expect(validationError(tableWith([])).path).toBe("table.builtins.example.signatures");
    expect(validationError(tableWith([signature], {}, "bad rule")).path).toBe(
      "table.builtins.example.rule",
    );
    expect(
      validationError({
        builtins: { example: { description: "", signatures: [signature] } },
      }).path,
    ).toBe("table.builtins.example.description");
    expect(
      validationError({
        builtins: { example: { category: 1, signatures: [signature] } },
      }).path,
    ).toBe("table.builtins.example.category");
    expect(validationError(tableWith([{ ...signature, typo: true }])).path).toBe(
      "table.builtins.example.signatures[0].typo",
    );
  });

  test("requires portable fallbacks and namespaced rule identifiers", () => {
    expect(validationError({ builtins: { example: { rule: "core.example" } } }).path).toBe(
      "table.builtins.example.signatures",
    );
    expect(validationError(tableWith([signature], {}, "handle")).path).toBe(
      "table.builtins.example.rule",
    );
    validateCallableTable(tableWith([signature], {}, "operator.handle"));
  });

  test("validates optional metering declarations", () => {
    validateCallableTable({
      builtins: {
        example: { metering: { base: 1, sized: [0, "rest"] }, signatures: [signature] },
      },
    });
    for (const metering of [
      { base: 0, sized: [] },
      { base: 1, sized: [-1] },
      { base: 1, sized: [0, 0] },
      { base: 1, sized: ["other"] },
    ]) {
      expect(() =>
        validateCallableTable({
          builtins: { example: { metering, signatures: [signature] } },
        }),
      ).toThrow(CallableTableValidationError);
    }
  });

  test("requires required, optional, and returns", () => {
    expect(validationError(tableWith([{ returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].required",
    );
    expect(validationError(tableWith([{ required: [], returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].optional",
    );
    expect(validationError(tableWith([{ required: [], optional: [] }])).path).toBe(
      "table.builtins.example.signatures[0].returns",
    );
    expect(validationError(tableWith([{ params: [], returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].params",
    );
    expect(validationError(tableWith([{ required: null, optional: [], returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].required",
    );
    expect(validationError(tableWith([{ required: [], optional: null, returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].optional",
    );
    expect(validationError(tableWith([{ ...signature, rest: null }])).path).toBe(
      "table.builtins.example.signatures[0].rest",
    );
  });

  test("validates type-variable declarations and uses", () => {
    expect(
      validationError(
        tableWith([
          {
            required: [{ $tvar: "T" }],
            optional: [],
            returns: { $tvar: "T" },
          },
        ]),
      ).message,
    ).toContain('undeclared type variable "T"');

    expect(
      validationError(
        tableWith([
          {
            typeParams: ["T", "T"],
            required: [{ $tvar: "T" }],
            optional: [],
            returns: { $tvar: "T" },
          },
        ]),
      ).message,
    ).toContain('duplicate type parameter "T"');

    expect(
      validationError(
        tableWith([
          {
            typeParams: ["T"],
            required: [true],
            optional: [],
            returns: true,
          },
        ]),
      ).message,
    ).toContain('declared type parameter "T" is not used');

    validateCallableTable(
      tableWith([
        {
          typeParams: ["T"],
          required: [],
          optional: [{ $tvar: "T" }],
          returns: true,
        },
      ]),
    );
  });

  test("validates references against the table definition pool", () => {
    const valid: unknown = tableWith(
      [{ required: [{ $ref: "#/$defs/Name" }], optional: [], returns: true }],
      {
        Name: { type: "string" },
      },
    );
    validateCallableTable(valid);

    expect(
      validationError(tableWith([{ required: [{ $ref: "Name" }], optional: [], returns: true }]))
        .path,
    ).toBe("table.builtins.example.signatures[0].required[0].$ref");
    expect(
      validationError(
        tableWith([{ required: [{ $ref: "#/$defs/Missing" }], optional: [], returns: true }]),
      ).message,
    ).toContain('references undefined type "Missing"');
  });

  test("rejects type variables in definitions", () => {
    expect(validationError(tableWith([signature], { Bad: { $tvar: "T" } })).message).toContain(
      "type variables are not allowed in definitions",
    );
  });

  test("rejects unsupported and malformed schema nodes", () => {
    expect(
      validationError(tableWith([{ required: [{ oneOf: [true] }], optional: [], returns: true }]))
        .path,
    ).toBe("table.builtins.example.signatures[0].required[0]");
    expect(
      validationError(tableWith([{ required: [], optional: [{ oneOf: [true] }], returns: true }]))
        .path,
    ).toBe("table.builtins.example.signatures[0].optional[0]");
    expect(
      validationError(
        tableWith([
          {
            required: [{ type: "array", items: { type: "mystery" } }],
            optional: [],
            returns: true,
          },
        ]),
      ).message,
    ).toContain('unsupported type "mystery"');
    expect(
      validationError(
        tableWith([
          {
            required: [{ $fnType: { required: [], optional: [], rest: null, returns: true } }],
            optional: [],
            returns: true,
          },
        ]),
      ).path,
    ).toBe("table.builtins.example.signatures[0].required[0].$fnType.rest");
    expect(
      validationError(
        tableWith([
          {
            required: [{ $fnType: { params: [], returns: true } }],
            optional: [],
            returns: true,
          },
        ]),
      ).path,
    ).toBe("table.builtins.example.signatures[0].required[0].$fnType.params");
  });

  test("validates tractable schema refinements", () => {
    expect(
      validationError(
        tableWith([{ required: [{ type: "string", pattern: "[" }], optional: [], returns: true }]),
      ).path,
    ).toBe("table.builtins.example.signatures[0].required[0].pattern");
    expect(
      validationError(
        tableWith([
          { required: [{ type: "array", minItems: 2, maxItems: 1 }], optional: [], returns: true },
        ]),
      ).message,
    ).toContain("minItems cannot exceed maxItems");
    expect(
      validationError(
        tableWith([
          {
            required: [
              {
                type: "object",
                properties: { known: { type: "string" } },
                required: ["missing"],
              },
            ],
            optional: [],
            returns: true,
          },
        ]),
      ).message,
    ).toContain('unknown property "missing"');
  });
});
