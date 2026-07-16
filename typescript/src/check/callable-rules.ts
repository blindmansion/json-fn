import type { JSONType } from "../types";
import { litOf } from "./ast";
import type { CallableTypeRuleRegistry, CallableTypeRuleV1 } from "./builtin-types";
import {
  apMode,
  asObject,
  classifySchema,
  collectSchemaRefs,
  fnShape,
  isSchemaObject,
  itemsSchema,
  isPortableTaskFloor,
  literalValues,
  mergeSchemas,
  prefixItems,
  properties,
  SchemaKind,
  taskCompletion,
  taskType,
  tupleRest,
  unionArms,
  unionOf,
  widenLiteral,
  type Schema,
} from "./schema";

class DuplicateCallableTypeRuleError extends Error {
  constructor(readonly ruleId: string) {
    super(`duplicate callable type rule "${ruleId}"`);
    this.name = "DuplicateCallableTypeRuleError";
  }
}

class CallableTypeRuleContractError extends Error {
  constructor(
    readonly ruleId: string,
    readonly fallback: Schema,
    readonly actual: Schema,
  ) {
    super(`callable type rule "${ruleId}" returned a type outside its portable fallback`);
    this.name = "CallableTypeRuleContractError";
  }
}

function mergeCallableTypeRuleRegistries(
  ...registries: CallableTypeRuleRegistry[]
): CallableTypeRuleRegistry {
  const merged: CallableTypeRuleRegistry = {};
  for (const registry of registries) {
    for (const [ruleId, rule] of Object.entries(registry)) {
      if (ruleId in merged) throw new DuplicateCallableTypeRuleError(ruleId);
      merged[ruleId] = rule;
    }
  }
  return merged;
}

const impreciseFallback: CallableTypeRuleV1 = (request, services) => {
  services.reportAnyDegradation(`callable rule "${request.name}" has no precise return type`);
  return request.fallbackResult;
};

function completionOf(schema: Schema, resolve: (schema: Schema) => Schema): Schema | null {
  const resolved = resolve(schema);
  if (classifySchema(resolved) === SchemaKind.TaskType) return taskCompletion(resolved);
  if (isPortableTaskFloor(resolved)) return true;
  const arms = unionArms(resolved);
  if (arms === null) return null;
  const completions = arms.map((arm) => completionOf(arm, resolve));
  return completions.some((completion) => completion === null)
    ? null
    : unionOf(completions as Schema[]);
}

const pureRule: CallableTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched || request.args.length !== 1) return request.fallbackResult;
  return taskType(services.synthArgument(0));
};

const raiseRule: CallableTypeRuleV1 = (request) => {
  if (!request.fallbackMatched || request.args.length !== 1) return request.fallbackResult;
  return taskType(false);
};

const performRule: CallableTypeRuleV1 = (request, services) => {
  if (request.args.length !== 2) return request.fallbackResult;
  const literal = litOf(request.args[0]!);
  if (literal === null) {
    services.reportCoverageDegradation("the effect name is dynamic");
    return request.fallbackResult;
  }
  if (typeof literal.v !== "string") return request.fallbackResult;

  if (services.effects === undefined) {
    services.reportCoverageDegradation("no effect manifest is configured");
    return request.fallbackResult;
  }
  const effect = services.effects[literal.v];
  if (effect === undefined) {
    services.reportError(`unknown effect "${literal.v}"`, { argumentIndex: 0 });
    return request.fallbackResult;
  }

  services.checkArgument(1, {
    type: "array",
    prefixItems: effect.params,
    items: false,
  });
  return taskType(effect.returns);
};

const bindRule: CallableTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched || request.args.length !== 2) return request.fallbackResult;

  const input = completionOf(services.synthArgument(0), services.resolveSchema);
  if (input === null) {
    services.checkArgument(0, taskType(true));
    return request.fallbackResult;
  }

  const expectedCallback: Schema = {
    $fnType: { params: [input], returns: taskType(true) },
  };
  let callbackReturn = services.contextualTypeCallback(1, expectedCallback);
  if (callbackReturn === null) {
    const callback = services.resolveSchema(services.synthArgument(1));
    if (classifySchema(callback) !== SchemaKind.FnType) {
      services.checkArgument(1, expectedCallback);
      return request.fallbackResult;
    }
    callbackReturn = fnShape(asObject(callback)).returns;
  }

  const output = completionOf(callbackReturn, services.resolveSchema);
  if (output === null) {
    services.reportError("bind continuation must return a Task", {
      argumentIndex: 1,
      expected: taskType(true),
      actual: callbackReturn,
    });
    return request.fallbackResult;
  }
  return taskType(output);
};

const mergeRule: CallableTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched || request.args.length !== 2) return request.fallbackResult;
  return mergeSchemas(services.synthArgument(0), services.synthArgument(1), services.defs);
};

function literalArrayElementSchema(schema: Schema): Schema | null {
  const values = literalValues(schema);
  if (!values.every(Array.isArray)) return null;
  return unionOf(
    values.flatMap((value) => value.map((item) => widenLiteral({ const: item } as Schema))),
  );
}

function flattenLiteralValue(value: JSONType): Schema {
  if (!Array.isArray(value)) return { const: value };
  return unionOf(value.map((item) => widenLiteral({ const: item } as Schema)));
}

function arrayElementSchema(schema: Schema, resolve: (schema: Schema) => Schema): Schema {
  const resolved = resolve(schema);
  const arms = unionArms(resolved);
  if (arms !== null) return unionOf(arms.map((arm) => arrayElementSchema(arm, resolve)));

  switch (classifySchema(resolved)) {
    case SchemaKind.Any:
      return true;
    case SchemaKind.Never:
      return false;
    case SchemaKind.Array:
      return itemsSchema(asObject(resolved));
    case SchemaKind.Tuple: {
      const tuple = asObject(resolved);
      const rest = tupleRest(tuple);
      return unionOf(
        (rest === null ? prefixItems(tuple) : [...prefixItems(tuple), rest]).map(widenLiteral),
      );
    }
    case SchemaKind.Const:
    case SchemaKind.Enum:
      return literalArrayElementSchema(resolved) ?? true;
    default:
      return true;
  }
}

function flattenOneArrayLevel(schema: Schema, resolve: (schema: Schema) => Schema): Schema {
  const resolved = resolve(schema);
  const arms = unionArms(resolved);
  if (arms !== null) return unionOf(arms.map((arm) => flattenOneArrayLevel(arm, resolve)));

  switch (classifySchema(resolved)) {
    case SchemaKind.Array:
      return itemsSchema(asObject(resolved));
    case SchemaKind.Tuple: {
      const tuple = asObject(resolved);
      const rest = tupleRest(tuple);
      return unionOf(
        (rest === null ? prefixItems(tuple) : [...prefixItems(tuple), rest]).map(widenLiteral),
      );
    }
    case SchemaKind.Const: {
      const [value] = literalValues(resolved);
      return value === undefined ? resolved : flattenLiteralValue(value);
    }
    case SchemaKind.Enum:
      return unionOf(literalValues(resolved).map(flattenLiteralValue));
    default:
      return resolved;
  }
}

const flatMapRule: CallableTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched || request.args.length !== 2) return request.fallbackResult;

  const item = arrayElementSchema(services.synthArgument(1), services.resolveSchema);
  const expectedCallback: Schema = {
    $fnType: {
      params: [item, { type: "integer" }],
      returns: true,
    },
  };
  let callbackReturn = services.contextualTypeCallback(0, expectedCallback);
  if (callbackReturn === null) {
    const callback = services.resolveSchema(services.synthArgument(0));
    if (classifySchema(callback) !== SchemaKind.FnType) return request.fallbackResult;
    callbackReturn = fnShape(asObject(callback)).returns;
  }

  return {
    type: "array",
    items: flattenOneArrayLevel(callbackReturn, services.resolveSchema),
  };
};

const handleRule: CallableTypeRuleV1 = (request, services) => {
  if (!request.fallbackMatched) return request.fallbackResult;
  if (request.args.length === 2) {
    services.reportAnyDegradation('callable rule "handle" has no precise return type');
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

const CORE_CALLABLE_TYPE_RULES: CallableTypeRuleRegistry = {
  "core.pipe": impreciseFallback,
  "core.apply": impreciseFallback,
  "core.perform": performRule,
  "core.pure": pureRule,
  "core.bind": bindRule,
  "core.raise": raiseRule,
  "core.handle": handleRule,
  "core.merge": mergeRule,
  "core.flatMap": flatMapRule,
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
    case SchemaKind.TaskType:
      return false;
    case SchemaKind.Opaque:
      return false;
  }
}

export {
  CORE_CALLABLE_TYPE_RULES,
  CallableTypeRuleContractError,
  DuplicateCallableTypeRuleError,
  mergeCallableTypeRuleRegistries,
};
