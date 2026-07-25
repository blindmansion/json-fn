import type { JSONType } from "../types.ts";
import type { Schema, Defs } from "./schema.ts";
import {
  SchemaKind,
  classifySchema,
  resolveRef,
  deepEqual,
  asObject,
  literalValues,
  unionArms,
  typeMatches,
  prefixItems,
  apMode,
  itemsSchema,
  properties,
  requiredKeys,
  tupleRest,
} from "./schema.ts";

type ValueMismatch = {
  path: Array<string | number>;
  reason: string;
};

function shown(value: JSONType): string {
  return JSON.stringify(value);
}

function mismatch(reason: string, path: Array<string | number> = []): ValueMismatch {
  return { path, reason };
}

function prepend(segment: string | number, failure: ValueMismatch): ValueMismatch {
  return { ...failure, path: [segment, ...failure.path] };
}

function valueMismatch(value: JSONType, schema: Schema, defs: Defs = {}): ValueMismatch | null {
  const kind = classifySchema(schema);
  switch (kind) {
    case SchemaKind.Any:
      return null;
    case SchemaKind.Never:
      return mismatch("the contract rejects every value");
    case SchemaKind.Ref:
      return valueMismatch(value, resolveRef(schema, defs), defs);
    case SchemaKind.Const:
      return deepEqual(value, asObject(schema).const!)
        ? null
        : mismatch(`${shown(value)} must equal ${shown(asObject(schema).const!)}`);
    case SchemaKind.Enum: {
      const allowed = literalValues(schema);
      return allowed.some((v) => deepEqual(value, v))
        ? null
        : mismatch(`${shown(value)} is not one of ${shown(allowed)}`);
    }
    case SchemaKind.Union: {
      const failures = (unionArms(schema) ?? []).map((arm) => valueMismatch(value, arm, defs));
      if (failures.some((failure) => failure === null)) return null;
      if (failures.length === 0) return mismatch("the contract has no matching union arms");
      const best = (failures as ValueMismatch[]).reduce((a, b) =>
        b.path.length > a.path.length ? b : a,
      );
      return { ...best, reason: `${best.reason}; no union arm matched` };
    }
    case SchemaKind.Primitive:
      return primitiveValueMismatch(value, asObject(schema));
    case SchemaKind.Array:
    case SchemaKind.Tuple:
      return arrayValueMismatch(value, asObject(schema), defs);
    case SchemaKind.Object:
      return objectValueMismatch(value, asObject(schema), defs);
    case SchemaKind.FnType:
      // Function-value validation (shape + embedded `$sig`) is a later concern;
      // a plain data literal never satisfies a function type.
      return mismatch("value is not callable");
    case SchemaKind.TaskType:
      return mismatch("task types cannot be used as runtime contracts");
    case SchemaKind.Opaque:
      return mismatch("the contract cannot be checked at runtime");
  }
}

function primitiveValueMismatch(
  value: JSONType,
  o: Record<string, JSONType>,
): ValueMismatch | null {
  const type = o.type as string;
  if (!typeMatches(value, type)) return mismatch(`${shown(value)} is not of type ${type}`);
  if (typeof value === "number") {
    if ("minimum" in o && value < (o.minimum as number)) {
      return mismatch(`${shown(value)} must be greater than or equal to ${o.minimum}`);
    }
    if ("maximum" in o && value > (o.maximum as number)) {
      return mismatch(`${shown(value)} must be less than or equal to ${o.maximum}`);
    }
    if ("exclusiveMinimum" in o && value <= (o.exclusiveMinimum as number)) {
      return mismatch(`${shown(value)} must be greater than ${o.exclusiveMinimum}`);
    }
    if ("exclusiveMaximum" in o && value >= (o.exclusiveMaximum as number)) {
      return mismatch(`${shown(value)} must be less than ${o.exclusiveMaximum}`);
    }
    if ("multipleOf" in o && value % (o.multipleOf as number) !== 0) {
      return mismatch(`${shown(value)} must be a multiple of ${o.multipleOf}`);
    }
  }
  if (typeof value === "string") {
    if ("minLength" in o && value.length < (o.minLength as number)) {
      return mismatch(`${shown(value)} must contain at least ${o.minLength} characters`);
    }
    if ("maxLength" in o && value.length > (o.maxLength as number)) {
      return mismatch(`${shown(value)} must contain at most ${o.maxLength} characters`);
    }
    if ("pattern" in o && !new RegExp(o.pattern as string).test(value)) {
      return mismatch(`${shown(value)} does not match pattern ${shown(o.pattern!)}`);
    }
  }
  return null;
}

function arrayValueMismatch(
  value: JSONType,
  o: Record<string, JSONType>,
  defs: Defs,
): ValueMismatch | null {
  if (!Array.isArray(value)) return mismatch(`${shown(value)} is not of type array`);
  if ("minItems" in o && value.length < (o.minItems as number)) {
    return mismatch(`expected at least ${o.minItems} items, received ${value.length}`);
  }
  if ("maxItems" in o && value.length > (o.maxItems as number)) {
    return mismatch(`expected at most ${o.maxItems} items, received ${value.length}`);
  }

  const prefix = prefixItems(o);
  const rest = "prefixItems" in o ? tupleRest(o) : itemsSchema(o);
  for (let i = 0; i < value.length; i++) {
    const elemSchema = prefix[i] ?? rest;
    if (elemSchema === null || elemSchema === undefined) {
      return mismatch("additional item is not allowed", [i]);
    }
    const failure = valueMismatch(value[i]!, elemSchema, defs);
    if (failure !== null) return prepend(i, failure);
  }
  const requiredPrefixLength =
    typeof o.minItems === "number" ? Math.min(o.minItems, prefix.length) : prefix.length;
  if (requiredPrefixLength > value.length) {
    return mismatch("required item is missing", [value.length]);
  }

  if (o.uniqueItems === true) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i]!, value[j]!)) {
          return mismatch(`duplicates item at index ${i}`, [j]);
        }
      }
    }
  }
  return null;
}

function objectValueMismatch(
  value: JSONType,
  o: Record<string, JSONType>,
  defs: Defs,
): ValueMismatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return mismatch(`${shown(value)} is not of type object`);
  }
  const v = value as Record<string, JSONType>;

  for (const k of requiredKeys(o)) {
    if (!(k in v)) return mismatch("required property is missing", [k]);
  }

  const props = properties(o);
  const mode = apMode(o);
  for (const [k, val] of Object.entries(v)) {
    if (k in props) {
      const failure = valueMismatch(val, props[k]!, defs);
      if (failure !== null) return prepend(k, failure);
    } else if (mode.kind === "closed") {
      return mismatch("additional property is not allowed", [k]);
    } else if (mode.kind === "map") {
      const failure = valueMismatch(val, mode.schema, defs);
      if (failure !== null) return prepend(k, failure);
    }
  }
  return null;
}

// Does a concrete JSON value satisfy a schema?
function valueSatisfies(value: JSONType, schema: Schema, defs: Defs = {}): boolean {
  return valueMismatch(value, schema, defs) === null;
}

export { valueMismatch, valueSatisfies };
export type { ValueMismatch };
