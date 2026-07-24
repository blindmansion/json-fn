import type { FunctionBody, FunctionRegistry } from "../types";

export type FunctionEnvironment = {
  functions: FunctionRegistry;
  localFns: ReadonlySet<string>;
  attachFns: ReadonlySet<string>;
};

const functionEnvironments = new WeakMap<FunctionBody, FunctionEnvironment>();

export function registerFunctionEnvironment(
  body: FunctionBody,
  environment: FunctionEnvironment,
): void {
  functionEnvironments.set(body, environment);
}

export function getFunctionEnvironment(body: FunctionBody): FunctionEnvironment | undefined {
  return functionEnvironments.get(body);
}
