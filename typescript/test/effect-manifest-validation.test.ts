import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EffectManifestValidationError,
  loadEffectManifest,
  validateEffectManifest,
} from "../src/environment/effects";

function validationError(value: unknown): EffectManifestValidationError {
  try {
    validateEffectManifest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(EffectManifestValidationError);
    return error as EffectManifestValidationError;
  }
  throw new Error("expected effect manifest validation to fail");
}

describe("effect manifest validation", () => {
  test("loads the language-agnostic example manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-fn-effects-"));
    const path = join(dir, "effects.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          "example.lookup": {
            params: [{ type: "integer" }],
            returns: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          "example.log": {
            params: [{ type: "string" }],
            returns: { type: "null" },
          },
        }),
      );
      const manifest = loadEffectManifest(path);
      expect(Object.keys(manifest)).toEqual(["example.lookup", "example.log"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts positional argument and result contracts", () => {
    const manifest = {
      "sensor.read": { params: [], returns: { $ref: "#/$defs/Reading" } },
      "sensor.set": { params: [{ type: "integer" }], returns: { type: "null" } },
    };
    validateEffectManifest(manifest, {
      Reading: { type: "object", properties: {}, additionalProperties: true },
    });
  });

  test("rejects malformed entries with effect-relative paths", () => {
    expect(validationError({ bad: [] }).path).toBe("effects.bad");
    expect(validationError({ bad: { returns: true } }).path).toBe("effects.bad.params");
    expect(validationError({ bad: { params: [] } }).path).toBe("effects.bad.returns");
    expect(validationError({ bad: { params: [], returns: true, typo: true } }).path).toBe(
      "effects.bad.typo",
    );
  });

  test("validates references against the supplied definition pool", () => {
    const error = validationError({
      read: { params: [], returns: { $ref: "#/$defs/Missing" } },
    });
    expect(error.path).toBe("effects.read.returns.$ref");
    expect(error.message).toContain('references undefined type "Missing"');
  });
});
