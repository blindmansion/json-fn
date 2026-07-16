import type { BuiltinTypeRuleRegistry, BuiltinTypeRuleV1 } from "./builtin-types";
import {
  apMode,
  asObject,
  classifySchema,
  collectSchemaRefs,
  fnShape,
  isSchemaObject,
  itemsSchema,
  mergeSchemas,
  prefixItems,
  properties,
  SchemaKind,
  tupleRest,
  unionArms,
  type Schema,
} from "./schema";

class DuplicateBuiltinTypeRuleError extends Error {
  constructor(readonly ruleId: string) {
    super(`duplicate builtin type rule "${ruleId}"`);
    this.name = "DuplicateBuiltinTypeRuleError";
  }
}

class BuiltinTypeRuleContractError extends Error {
  constructor(
    readonly ruleId: string,
    readonly fallback: Schema,
    readonly actual: Schema,
  ) {
    super(`builtin type rule "${ruleId}" returned a type outside its portable fallback`);
    this.name = "BuiltinTypeRuleContractError";
  }
}

function mergeBuiltinTypeRuleRegistries(
  ...registries: BuiltinTypeRuleRegistry[]
): BuiltinTypeRuleRegistry {
  const merged: BuiltinTypeRuleRegistry = {};
  for (const registry of registries) {
    for (const [ruleId, rule] of Object.entries(registry)) {
      if (ruleId in merged) throw new DuplicateBuiltinTypeRuleError(ruleId);
      merged[ruleId] = rule;
    }
  }
  return merged;
}

const preserveFallback: BuiltinTypeRuleV1 = ({ fallbackResult }) => fallbackResult;

const impreciseFallback: BuiltinTypeRuleV1 = (request, services) => {
  services.reportAnyDegradation(`builtin rule "${request.name}" has no precise return type`);
  return request.fallbackResult;
};

const mergeRule: BuiltinTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched || request.args.length !== 2) return request.fallbackResult;
  return mergeSchemas(services.synthArgument(0), services.synthArgument(1), services.defs);
};

const handleRule: BuiltinTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched) return request.fallbackResult;
  if (request.args.length === 2) {
    services.reportAnyDegradation('builtin rule "handle" has no precise return type');
    return true;
  }
  if (request.args.length !== 3) return request.fallbackResult;

  const annotationExpr = request.args[2]!;
  if (
    !isSchemaObject(annotationExpr) ||
    Object.keys(annotationExpr).length !== 1 ||
    !("$raw" in annotationExpr)
  ) {
    services.reportError("annotated handle requires a raw result-type schema", {
      argumentIndex: 2,
    });
    return true;
  }

  const schema = annotationExpr.$raw!;
  if (!isTractableHandleSchema(schema)) {
    services.reportError("handle result annotation is outside the tractable type fragment", {
      argumentIndex: 2,
      path: ["$raw"],
    });
    return true;
  }

  const refs = new Set<string>();
  collectSchemaRefs(schema, refs);
  for (const name of refs) {
    if (!(name in services.defs)) {
      services.reportError(`reference to undefined type "${name}"`, {
        argumentIndex: 2,
        path: ["$raw"],
      });
    }
  }
  return schema;
};

const CORE_BUILTIN_TYPE_RULES: BuiltinTypeRuleRegistry = {
  "core.pipe": impreciseFallback,
  "core.apply": impreciseFallback,
  "core.perform": preserveFallback,
  "core.pure": preserveFallback,
  "core.bind": preserveFallback,
  "core.raise": preserveFallback,
  "core.handle": handleRule,
  "core.merge": mergeRule,
};

function isLiteralSchemaValue(value: unknown): boolean {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

function isTractableHandleSchema(schema: Schema): boolean {
  switch (classifySchema(schema)) {
    case SchemaKind.Any:
    case SchemaKind.Never:
      return true;
    case SchemaKind.Ref:
      return typeof asObject(schema).$ref === "string";
    case SchemaKind.Const:
      return isLiteralSchemaValue(asObject(schema).const);
    case SchemaKind.Enum: {
      const values = asObject(schema).enum;
      return Array.isArray(values) && values.every(isLiteralSchemaValue);
    }
    case SchemaKind.Union: {
      const arms = unionArms(schema);
      return arms !== null && arms.every(isTractableHandleSchema);
    }
    case SchemaKind.Primitive:
      return ["null", "boolean", "number", "integer", "string"].includes(
        String(asObject(schema).type),
      );
    case SchemaKind.Array:
      return isTractableHandleSchema(itemsSchema(asObject(schema)));
    case SchemaKind.Tuple: {
      const object = asObject(schema);
      const rest = tupleRest(object);
      return (
        prefixItems(object).every(isTractableHandleSchema) &&
        (rest === null || isTractableHandleSchema(rest))
      );
    }
    case SchemaKind.Object: {
      const object = asObject(schema);
      const mode = apMode(object);
      return (
        Object.values(properties(object)).every(isTractableHandleSchema) &&
        (mode.kind !== "map" || isTractableHandleSchema(mode.schema))
      );
    }
    case SchemaKind.FnType: {
      if (!isSchemaObject(asObject(schema).$fnType)) return false;
      const shape = fnShape(asObject(schema));
      return (
        shape.params.every(isTractableHandleSchema) &&
        (shape.rest === undefined || isTractableHandleSchema(shape.rest)) &&
        isTractableHandleSchema(shape.returns)
      );
    }
    case SchemaKind.Opaque:
      return false;
  }
}

export {
  CORE_BUILTIN_TYPE_RULES,
  BuiltinTypeRuleContractError,
  DuplicateBuiltinTypeRuleError,
  mergeBuiltinTypeRuleRegistries,
};
