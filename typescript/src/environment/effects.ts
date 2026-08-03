import { readFileSync } from "fs";
import type { CallableTable } from "../check/builtin-types";
import { taskType, type Defs, type Schema } from "../schema/schema.ts";
import { CallableTableValidationError, validateCallableTable } from "../builtins";
import { getOwnProperty, setOwnProperty } from "../own-properties";
import { assertStructuralDepth } from "../structural-depth";
import type { JSONType } from "../types";
import type { EffectManifest } from "./effect-types";
const EFFECTS_BINDING = "effects";

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
 * into one operator-owned contract.
 */
function validateEffectManifest(value: unknown, defs: Defs = {}): asserts value is EffectManifest {
  assertStructuralDepth(value);
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
    for (const key of Object.keys(signature)) {
      if (key !== "params" && key !== "returns") {
        throw new EffectManifestValidationError(`${path}.${key}`, "unsupported field");
      }
    }

    const synthetic: CallableTable = {
      $defs: defs,
      builtins: {
        effect: {
          signatures: [
            {
              required: signature.params as Schema[],
              optional: [],
              returns: signature.returns as Schema,
            },
          ],
        },
      },
    };
    try {
      validateCallableTable(synthetic);
    } catch (error) {
      if (!(error instanceof CallableTableValidationError)) throw error;
      const suffix = error.path
        .replace(/^table\.builtins\.effect\.signatures\[0\]/, "")
        .replace(/^\.required/, ".params");
      throw new EffectManifestValidationError(
        `${path}${suffix}`,
        error.message.slice(error.path.length + 2),
      );
    }
  }

  const names = Object.keys(value).sort();
  for (let i = 0; i < names.length - 1; i++) {
    const prefix = names[i]!;
    const name = names[i + 1]!;
    if (name.startsWith(`${prefix}.`)) {
      throw new EffectManifestValidationError(
        `effects.${name}`,
        `effect name conflicts with namespace prefix "${prefix}"`,
      );
    }
  }
}

function loadEffectManifest(path: string, defs: Defs = {}): EffectManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateEffectManifest(parsed, defs);
  return parsed;
}

/**
 * Materialize the operator's effect manifest as an ordinary nested guest value.
 * Each leaf is a typed json-fn function that constructs the same inert task as
 * a literal `perform(name, args)` call. The checker and runtime both inject this
 * exact value, keeping source ergonomics separate from task semantics.
 */
function buildEffectNamespace(effects: EffectManifest = {}): Record<string, JSONType> {
  const root: Record<string, JSONType> = {};
  for (const [name, signature] of Object.entries(effects)) {
    const segments = name.split(".");
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      const child = getOwnProperty(parent, segment);
      if (child === undefined) {
        const created: Record<string, JSONType> = {};
        setOwnProperty(parent, segment, created);
        parent = created;
      } else {
        parent = child as Record<string, JSONType>;
      }
    }

    const params = signature.params.map((_, index) => `_effectArg${index}`);
    setOwnProperty(parent, segments.at(-1)!, {
      $params: params,
      $sig: {
        required: signature.params,
        optional: [],
        returns: taskType(signature.returns),
      },
      $return: {
        $call: "perform",
        $args: [name, params.map((param) => ({ $var: param }))],
      },
    });
  }
  return root;
}

export {
  EFFECTS_BINDING,
  EffectManifestValidationError,
  buildEffectNamespace,
  loadEffectManifest,
  validateEffectManifest,
};
