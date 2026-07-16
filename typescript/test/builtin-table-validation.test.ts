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
  params: [{ type: "string" }],
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
      description: "test table",
      builtins: {
        declarative: { signatures: [signature] },
        special: { signatures: [signature], rule: "core.handle" },
      },
    };
    validateCallableTable(value);
    expect(value.builtins.declarative!.signatures).toHaveLength(1);
  });

  test("rejects malformed table and entry shapes", () => {
    expect(validationError({}).path).toBe("table.builtins");
    expect(validationError({ builtins: { example: [] } }).path).toBe("table.builtins.example");
    expect(validationError(tableWith([])).path).toBe("table.builtins.example.signatures");
    expect(validationError(tableWith([signature], {}, "bad rule")).path).toBe(
      "table.builtins.example.rule",
    );
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

  test("requires signature parameters and returns", () => {
    expect(validationError(tableWith([{ returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].params",
    );
    expect(validationError(tableWith([{ params: [] }])).path).toBe(
      "table.builtins.example.signatures[0].returns",
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
            params: [{ $tvar: "T" }],
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
            params: [{ $tvar: "T" }],
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
            params: [true],
            returns: true,
          },
        ]),
      ).message,
    ).toContain('declared type parameter "T" is not used');
  });

  test("validates references against the table definition pool", () => {
    const valid: unknown = tableWith([{ params: [{ $ref: "#/$defs/Name" }], returns: true }], {
      Name: { type: "string" },
    });
    validateCallableTable(valid);

    expect(validationError(tableWith([{ params: [{ $ref: "Name" }], returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].params[0].$ref",
    );
    expect(
      validationError(tableWith([{ params: [{ $ref: "#/$defs/Missing" }], returns: true }]))
        .message,
    ).toContain('references undefined type "Missing"');
  });

  test("rejects type variables in definitions", () => {
    expect(validationError(tableWith([signature], { Bad: { $tvar: "T" } })).message).toContain(
      "type variables are not allowed in definitions",
    );
  });

  test("rejects unsupported and malformed schema nodes", () => {
    expect(validationError(tableWith([{ params: [{ oneOf: [true] }], returns: true }])).path).toBe(
      "table.builtins.example.signatures[0].params[0]",
    );
    expect(
      validationError(
        tableWith([
          {
            params: [{ type: "array", items: { type: "mystery" } }],
            returns: true,
          },
        ]),
      ).message,
    ).toContain('unsupported type "mystery"');
    expect(
      validationError(
        tableWith([
          {
            params: [{ $fnType: { params: [], rest: null, returns: true } }],
            returns: true,
          },
        ]),
      ).path,
    ).toBe("table.builtins.example.signatures[0].params[0].$fnType.rest");
  });

  test("validates tractable schema refinements", () => {
    expect(
      validationError(tableWith([{ params: [{ type: "string", pattern: "[" }], returns: true }]))
        .path,
    ).toBe("table.builtins.example.signatures[0].params[0].pattern");
    expect(
      validationError(
        tableWith([{ params: [{ type: "array", minItems: 2, maxItems: 1 }], returns: true }]),
      ).message,
    ).toContain("minItems cannot exceed maxItems");
    expect(
      validationError(
        tableWith([
          {
            params: [
              {
                type: "object",
                properties: { known: { type: "string" } },
                required: ["missing"],
              },
            ],
            returns: true,
          },
        ]),
      ).message,
    ).toContain('unknown property "missing"');
  });
});
