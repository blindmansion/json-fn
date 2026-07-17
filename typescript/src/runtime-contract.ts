import type { FunctionBody, JSONType } from "./types";
import type { Defs, FnTypeShape, Schema } from "./check/schema";
import {
  SchemaKind,
  classifySchema,
  collectSchemaRefs,
  fixedParamSchemas,
  fnShape,
  isSchemaObject,
  refName,
  unionArms,
} from "./check/schema";
import { valueSatisfies } from "./check/values";
import { raw } from "./utils";

const CONTRACT_KEY = "$runtimeContract";
const CONTRACT_ARGS = "__contractArgs";

type RuntimeFunctionContract = {
  schema: Schema;
  defs: Defs;
  target: JSONType;
};

export class RuntimeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeContractError";
  }
}

function isCallable(value: JSONType): boolean {
  return typeof value === "string" || (isSchemaObject(value) && "$return" in value);
}

function resolveSchema(schema: Schema, defs: Defs, seen = new Set<string>()): Schema {
  let current = schema;
  while (classifySchema(current) === SchemaKind.Ref) {
    const name = refName(current);
    if (seen.has(name)) {
      throw new RuntimeContractError(`runtime contract contains a cyclic reference to "${name}"`);
    }
    seen.add(name);
    const resolved = defs[name];
    if (resolved === undefined) {
      throw new RuntimeContractError(`runtime contract references undefined type "${name}"`);
    }
    current = resolved;
  }
  return current;
}

function assertReferencesDefined(schema: Schema, defs: Defs, seen = new Set<string>()): void {
  const refs = new Set<string>();
  collectSchemaRefs(schema, refs);
  for (const name of refs) {
    const resolved = defs[name];
    if (resolved === undefined) {
      throw new RuntimeContractError(`runtime contract references undefined type "${name}"`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    assertReferencesDefined(resolved, defs, seen);
  }
}

function functionShapes(schema: Schema, defs: Defs, seen = new Set<Schema>()): FnTypeShape[] {
  const resolved = resolveSchema(schema, defs);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  switch (classifySchema(resolved)) {
    case SchemaKind.FnType:
      return [fnShape(resolved as Record<string, JSONType>)];
    case SchemaKind.Union:
      return (unionArms(resolved) ?? []).flatMap((arm) => functionShapes(arm, defs, seen));
    default:
      return [];
  }
}

function contractFailure(label: string, schema: Schema): RuntimeContractError {
  return new RuntimeContractError(
    `${label} contract failed: value does not satisfy ${JSON.stringify(schema)}`,
  );
}

function wrapFunction(value: JSONType, schema: Schema, defs: Defs): JSONType {
  const contract: RuntimeFunctionContract = { schema, defs, target: value };
  return raw({
    $params: [`...${CONTRACT_ARGS}`],
    [CONTRACT_KEY]: contract as unknown as JSONType,
    // The evaluator recognizes the metadata above and calls `target` directly.
    // Keeping an inert return makes this remain an ordinary serializable
    // function body without relying on a shadowable internal builtin name.
    $return: null,
  });
}

/**
 * Enforce a concrete boundary contract. Data is checked immediately. Function
 * values are wrapped in a serializable function body whose arguments and
 * eventual return value are checked by the evaluator at each invocation.
 */
export function enforceRuntimeContract(
  value: JSONType,
  schema: Schema,
  defs: Defs = {},
  label = "runtime",
): JSONType {
  assertReferencesDefined(schema, defs);
  const resolved = resolveSchema(schema, defs);
  if (resolved === true) return value;
  if (valueSatisfies(value, resolved, defs)) return value;
  if (isCallable(value) && functionShapes(resolved, defs).length > 0) {
    return wrapFunction(value, resolved, defs);
  }
  throw contractFailure(label, schema);
}

export function readRuntimeFunctionContract(fn: FunctionBody): RuntimeFunctionContract | null {
  const candidate = fn[CONTRACT_KEY];
  if (!isSchemaObject(candidate)) return null;
  if (
    !("schema" in candidate) ||
    !isSchemaObject(candidate.defs) ||
    !("target" in candidate) ||
    !isCallable(candidate.target!)
  )
    return null;
  return {
    schema: candidate.schema!,
    defs: candidate.defs as Defs,
    target: candidate.target!,
  };
}

/**
 * Select the first function-contract arm whose parameter contracts accept this
 * call. This gives function unions overload-like runtime behavior while making
 * only one call to the wrapped function.
 */
export function prepareRuntimeContractCall(
  contract: RuntimeFunctionContract,
  args: JSONType[],
): { args: JSONType[]; returns: Schema } {
  const shapes = functionShapes(contract.schema, contract.defs);
  for (const shape of shapes) {
    const fixed = fixedParamSchemas(shape);
    if (shape.rest === undefined && args.length !== fixed.length) continue;
    if (shape.rest !== undefined && args.length < fixed.length) continue;

    try {
      const checked = args.map((arg, index) => {
        const schema = fixed[index] ?? shape.rest!;
        return enforceRuntimeContract(arg, schema, contract.defs, `function argument ${index + 1}`);
      });
      return { args: checked, returns: shape.returns };
    } catch (error) {
      if (!(error instanceof RuntimeContractError)) throw error;
    }
  }
  throw contractFailure("function arguments", contract.schema);
}

export function enforceRuntimeContractReturn(
  value: JSONType,
  schema: Schema,
  defs: Defs,
): JSONType {
  return enforceRuntimeContract(value, schema, defs, "function return");
}

export { CONTRACT_KEY };
