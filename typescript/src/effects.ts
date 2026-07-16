import { readFileSync } from "fs";
import type { CallableTable } from "./check/builtin-types";
import type { Defs, Schema } from "./check/schema";
import { CallableTableValidationError, validateCallableTable } from "./builtins";

type EffectSignature = { params: Schema[]; returns: Schema };
type EffectManifest = Record<string, EffectSignature>;

class EffectManifestValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "EffectManifestValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the portable effect table with the same schema dialect as callable
 * contracts. Definitions are supplied separately because slice 8 packages both
 * into one operator-owned environment.
 */
function validateEffectManifest(value: unknown, defs: Defs = {}): asserts value is EffectManifest {
  if (!isObject(value)) {
    throw new EffectManifestValidationError("effects", "expected an object");
  }

  for (const [name, signature] of Object.entries(value)) {
    const path = `effects.${name}`;
    if (name.length === 0) {
      throw new EffectManifestValidationError(path, "effect name cannot be empty");
    }
    if (!isObject(signature)) {
      throw new EffectManifestValidationError(path, "expected an object");
    }

    const synthetic: CallableTable = {
      $defs: defs,
      builtins: {
        effect: {
          signatures: [signature as EffectSignature],
        },
      },
    };
    try {
      validateCallableTable(synthetic);
    } catch (error) {
      if (!(error instanceof CallableTableValidationError)) throw error;
      const suffix = error.path.replace(/^table\.builtins\.effect\.signatures\[0\]/, "");
      throw new EffectManifestValidationError(
        `${path}${suffix}`,
        error.message.slice(error.path.length + 2),
      );
    }
  }
}

function loadEffectManifest(path: string, defs: Defs = {}): EffectManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateEffectManifest(parsed, defs);
  return parsed;
}

export { EffectManifestValidationError, loadEffectManifest, validateEffectManifest };
export type { EffectManifest, EffectSignature };
