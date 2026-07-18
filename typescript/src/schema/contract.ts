import {
  apMode,
  asObject,
  classifySchema,
  fixedParamSchemas,
  fnShape,
  isSchemaObject,
  itemsSchema,
  prefixItems,
  properties,
  SchemaKind,
  tupleRest,
  unionArms,
  type Schema,
} from "./schema.ts";

function isLiteralSchemaValue(value: unknown): boolean {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

function isRuntimeContractSchema(schema: Schema): boolean {
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
      return arms !== null && arms.every(isRuntimeContractSchema);
    }
    case SchemaKind.Primitive:
      return ["null", "boolean", "number", "integer", "string"].includes(
        String(asObject(schema).type),
      );
    case SchemaKind.Array:
      return isRuntimeContractSchema(itemsSchema(asObject(schema)));
    case SchemaKind.Tuple: {
      const object = asObject(schema);
      const rest = tupleRest(object);
      return (
        prefixItems(object).every(isRuntimeContractSchema) &&
        (rest === null || isRuntimeContractSchema(rest))
      );
    }
    case SchemaKind.Object: {
      const object = asObject(schema);
      const mode = apMode(object);
      return (
        Object.values(properties(object)).every(isRuntimeContractSchema) &&
        (mode.kind !== "map" || isRuntimeContractSchema(mode.schema))
      );
    }
    case SchemaKind.FnType: {
      if (!isSchemaObject(asObject(schema).$fnType)) return false;
      const shape = fnShape(asObject(schema));
      return (
        fixedParamSchemas(shape).every(isRuntimeContractSchema) &&
        (shape.rest === undefined || isRuntimeContractSchema(shape.rest)) &&
        isRuntimeContractSchema(shape.returns)
      );
    }
    case SchemaKind.TaskType:
    case SchemaKind.Opaque:
      return false;
  }
}

export { isRuntimeContractSchema };
