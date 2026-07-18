import type { JSONType } from "../types";
import type { Schema, Defs } from "./schema";
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
} from "./schema";

// Does a concrete JSON value satisfy a schema?
function valueSatisfies(value: JSONType, schema: Schema, defs: Defs = {}): boolean {
  const kind = classifySchema(schema);
  switch (kind) {
    case SchemaKind.Any:
      return true;
    case SchemaKind.Never:
      return false;
    case SchemaKind.Ref:
      return valueSatisfies(value, resolveRef(schema, defs), defs);
    case SchemaKind.Const:
      return deepEqual(value, asObject(schema).const!);
    case SchemaKind.Enum:
      return literalValues(schema).some((v) => deepEqual(value, v));
    case SchemaKind.Union:
      return (unionArms(schema) ?? []).some((arm) => valueSatisfies(value, arm, defs));
    case SchemaKind.Primitive:
      return primitiveValueMatches(value, asObject(schema));
    case SchemaKind.Array:
    case SchemaKind.Tuple:
      return arrayValueMatches(value, asObject(schema), defs);
    case SchemaKind.Object:
      return objectValueMatches(value, asObject(schema), defs);
    case SchemaKind.FnType:
      // Function-value validation (shape + embedded `$sig`) is a later concern;
      // a plain data literal never satisfies a function type.
      return false;
    case SchemaKind.TaskType:
      return false; // checker-only completion index; never a runtime contract
    case SchemaKind.Opaque:
      return false; // not statically decidable
  }
}

function primitiveValueMatches(value: JSONType, o: Record<string, JSONType>): boolean {
  if (!typeMatches(value, o.type as string)) return false;
  if (typeof value === "number") {
    if ("minimum" in o && value < (o.minimum as number)) return false;
    if ("maximum" in o && value > (o.maximum as number)) return false;
    if ("exclusiveMinimum" in o && value <= (o.exclusiveMinimum as number)) return false;
    if ("exclusiveMaximum" in o && value >= (o.exclusiveMaximum as number)) return false;
    if ("multipleOf" in o && value % (o.multipleOf as number) !== 0) return false;
  }
  if (typeof value === "string") {
    if ("minLength" in o && value.length < (o.minLength as number)) return false;
    if ("maxLength" in o && value.length > (o.maxLength as number)) return false;
    if ("pattern" in o && !new RegExp(o.pattern as string).test(value)) return false;
  }
  return true;
}

function arrayValueMatches(value: JSONType, o: Record<string, JSONType>, defs: Defs): boolean {
  if (!Array.isArray(value)) return false;
  if ("minItems" in o && value.length < (o.minItems as number)) return false;
  if ("maxItems" in o && value.length > (o.maxItems as number)) return false;

  const prefix = prefixItems(o);
  const rest = "prefixItems" in o ? tupleRest(o) : itemsSchema(o);
  for (let i = 0; i < value.length; i++) {
    const elemSchema = prefix[i] ?? rest;
    if (elemSchema === null || elemSchema === undefined) return false; // closed tuple overflow
    if (!valueSatisfies(value[i]!, elemSchema, defs)) return false;
  }
  const requiredPrefixLength =
    typeof o.minItems === "number" ? Math.min(o.minItems, prefix.length) : prefix.length;
  if (requiredPrefixLength > value.length) return false; // missing required tuple elements

  if (o.uniqueItems === true) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i]!, value[j]!)) return false;
      }
    }
  }
  return true;
}

function objectValueMatches(value: JSONType, o: Record<string, JSONType>, defs: Defs): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, JSONType>;

  for (const k of requiredKeys(o)) {
    if (!(k in v)) return false;
  }

  const props = properties(o);
  const mode = apMode(o);
  for (const [k, val] of Object.entries(v)) {
    if (k in props) {
      if (!valueSatisfies(val, props[k]!, defs)) return false;
    } else if (mode.kind === "closed") {
      return false;
    } else if (mode.kind === "map" && !valueSatisfies(val, mode.schema, defs)) {
      return false;
    }
  }
  return true;
}

export { valueSatisfies };
