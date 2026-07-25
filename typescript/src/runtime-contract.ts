import type { FunctionBody, JSONType } from "./types";
import { isFunctionDeclaration } from "./function-value";
import { isReadableRuntimeFunctionContract } from "./function-body-structure";
import type { Defs, FnTypeShape, Schema } from "./schema/schema.ts";
import { isRuntimeContractSchema } from "./schema/contract.ts";
import {
  SchemaKind,
  classifySchema,
  collectSchemaRefs,
  fixedParamSchemas,
  fnShape,
  refName,
  unionArms,
} from "./schema/schema.ts";
import { valueMismatch, valueSatisfies } from "./schema/values.ts";
import { raw } from "./utils";

const CONTRACT_ARGS = "__contractArgs";

type RuntimeFunctionContract = {
  schema: Schema;
  defs: Defs;
  target: JSONType;
};

export class RuntimeContractError extends Error {
  readonly code = "RUNTIME_CONTRACT_FAILED";

  constructor(
    message: string,
    readonly path?: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "RuntimeContractError";
  }
}

function isCallable(value: JSONType): boolean {
  return isFunctionDeclaration(value);
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

function pathSegment(segment: string | number): string {
  if (typeof segment === "number") return `[${segment}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    ? `.${segment}`
    : `[${JSON.stringify(segment)}]`;
}

function contractFailure(
  label: string,
  value: JSONType,
  schema: Schema,
  defs: Defs,
  rootPath: string,
): RuntimeContractError {
  const failure = valueMismatch(value, schema, defs);
  const path = `${rootPath}${failure?.path.map(pathSegment).join("") ?? ""}`;
  const reason = failure?.reason ?? "value does not satisfy the contract";
  return new RuntimeContractError(`${label} contract failed at ${path}: ${reason}`, path, reason);
}

function wrapFunction(value: JSONType, schema: Schema, defs: Defs): JSONType {
  const contract: RuntimeFunctionContract = { schema, defs, target: value };
  return raw({
    $params: [`...${CONTRACT_ARGS}`],
    $runtimeContract: contract as unknown as JSONType,
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
  rootPath = "value",
): JSONType {
  if (!isRuntimeContractSchema(schema)) {
    throw new RuntimeContractError(
      `${label} contract failed: unsupported schema ${JSON.stringify(schema)}`,
    );
  }
  assertReferencesDefined(schema, defs);
  const resolved = resolveSchema(schema, defs);
  if (resolved === true) return value;
  if (valueSatisfies(value, resolved, defs)) return value;
  if (isCallable(value) && functionShapes(resolved, defs).length > 0) {
    return wrapFunction(value, resolved, defs);
  }
  throw contractFailure(label, value, schema, defs, rootPath);
}

export function readRuntimeFunctionContract(fn: FunctionBody): RuntimeFunctionContract | null {
  const candidate = fn.$runtimeContract;
  if (!isReadableRuntimeFunctionContract(candidate)) return null;
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
  let firstFailure: RuntimeContractError | undefined;
  for (const shape of shapes) {
    const fixed = fixedParamSchemas(shape);
    if (shape.rest === undefined && args.length !== fixed.length) continue;
    if (shape.rest !== undefined && args.length < fixed.length) continue;

    try {
      const checked = args.map((arg, index) => {
        const schema = fixed[index] ?? shape.rest!;
        return enforceRuntimeContract(
          arg,
          schema,
          contract.defs,
          `function argument ${index + 1}`,
          `args[${index}]`,
        );
      });
      return { args: checked, returns: shape.returns };
    } catch (error) {
      if (!(error instanceof RuntimeContractError)) throw error;
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) {
    throw new RuntimeContractError(
      `function arguments contract failed at ${firstFailure.path}: ${firstFailure.reason}`,
      firstFailure.path,
      firstFailure.reason,
    );
  }
  throw new RuntimeContractError(
    `function arguments contract failed at args: received ${args.length} arguments, but no function contract arm accepts that arity`,
    "args",
    `received ${args.length} arguments, but no function contract arm accepts that arity`,
  );
}

export function enforceRuntimeContractReturn(
  value: JSONType,
  schema: Schema,
  defs: Defs,
): JSONType {
  return enforceRuntimeContract(value, schema, defs, "function return", "return");
}
