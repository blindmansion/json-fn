import { describe, expect, test } from "bun:test";
import { basename, dirname, join, relative, sep } from "path";
import { readdirSync, readFileSync } from "fs";
import { callFunction, createStdlib, loadBuiltinTable } from "../src";
import type { FunctionDeclaration, FunctionRegistry, JSONType, Meter } from "../src";
import { isBuiltin, isMeteredPure, isPure } from "../src/utils";

type ReturnOutcome = { returns: JSONType };
type ThrowOutcome = { throws: { messageIncludes: string } };
type Outcome = ReturnOutcome | ThrowOutcome;

type CallbackStep = {
  args: JSONType[];
  outcome: Outcome;
};

type CallbackInput = {
  $callback: {
    steps: CallbackStep[];
  };
};

type BuiltinInput = {
  $builtin: string;
};

type FunctionInput = {
  $function: {
    name: string;
    body: Record<string, JSONType>;
  };
};

type LiteralInput = {
  $literal: JSONType;
};

type CaseInput = JSONType | CallbackInput | BuiltinInput | FunctionInput | LiteralInput;

type LogObservation = {
  value: JSONType;
  label?: string;
};

type TestCase = {
  description: string;
  comment?: string;
  args: CaseInput[];
  outcome: Outcome;
  observations?: {
    logs?: LogObservation[];
    meter?: {
      charged?: number;
      guardedSizes?: number[];
    };
  };
};

type TestSuite = {
  $schema: "../../builtin.schema.json";
  builtin: string;
  description: string;
  cases: TestCase[];
};

type CallbackState = {
  steps: CallbackStep[];
  nextStep: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DirectBuiltinHarness {
  readonly logs: LogObservation[] = [];
  readonly guardedSizes: number[] = [];
  charged = 0;

  private readonly functions: FunctionRegistry;
  private readonly callbacks = new Map<object, CallbackState>();
  private readonly builtinReferences = new Map<object, string>();

  constructor() {
    this.functions = createStdlib({
      logger: (value, label) => {
        this.logs.push(label === undefined ? { value } : { value, label });
      },
    });
  }

  decodeArgs(inputs: CaseInput[]): JSONType[] {
    return inputs.map((input) => this.decodeInput(input));
  }

  invoke(name: string, args: JSONType[]): JSONType {
    const entry = this.functions[name];
    if (typeof entry !== "function") throw new Error(`Builtin ${name} not found`);

    if (isBuiltin(entry)) {
      return entry(args, this.call, this.functions, this.meter, { defs: {} });
    }
    if (isMeteredPure(entry)) return entry(this.meter, ...args) as JSONType;
    if (isPure(entry)) return entry(...args) as JSONType;
    throw new Error(`Builtin ${name} does not expose a supported direct conformance ABI`);
  }

  verifyFixtures(): void {
    for (const state of this.callbacks.values()) {
      expect(state.nextStep, "callback did not consume every scripted step").toBe(
        state.steps.length,
      );
    }
  }

  private readonly meter: Meter = {
    charge: (amount) => {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new Error(`Invalid builtin meter charge: ${amount}`);
      }
      this.charged += amount;
    },
    guardSize: (size) => {
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid builtin guarded size: ${size}`);
      }
      this.guardedSizes.push(size);
    },
  };

  private readonly call = (fn: JSONType, args: JSONType[]): JSONType => {
    if (isRecord(fn)) {
      const callback = this.callbacks.get(fn);
      if (callback !== undefined) {
        const step = callback.steps[callback.nextStep];
        if (step === undefined) throw new Error("Callback received an unexpected extra call");
        callback.nextStep++;
        expect(args, `callback call ${callback.nextStep} arguments`).toEqual(step.args);
        if ("throws" in step.outcome) throw new Error(step.outcome.throws.messageIncludes);
        return step.outcome.returns;
      }

      const builtinName = this.builtinReferences.get(fn);
      if (builtinName !== undefined) return this.invoke(builtinName, args);

      if ("$return" in fn) {
        return callFunction(fn as FunctionDeclaration, args, this.functions);
      }
    }
    throw new Error("Builtin attempted to call an unknown callback fixture");
  };

  private decodeInput(input: CaseInput): JSONType {
    if (Array.isArray(input)) {
      return input.map((item) => this.decodeInput(item as CaseInput));
    }
    if (!isRecord(input)) return input as JSONType;
    const record = input as Record<string, unknown>;

    if (hasOnlyKeys(record, ["$literal"])) return record.$literal as JSONType;

    if (hasOnlyKeys(record, ["$builtin"]) && typeof record.$builtin === "string") {
      const token = {};
      this.builtinReferences.set(token, record.$builtin);
      return token;
    }

    if (hasOnlyKeys(record, ["$function"]) && isRecord(record.$function)) {
      const { name, body } = record.$function;
      if (typeof name !== "string" || name.length === 0 || !isRecord(body)) {
        throw new Error("Function fixture requires a non-empty name and function body");
      }
      this.functions[name] = body as FunctionRegistry[string];
      return name;
    }

    if (hasOnlyKeys(record, ["$callback"]) && isRecord(record.$callback)) {
      const steps = record.$callback.steps;
      if (!Array.isArray(steps)) throw new Error("Callback fixture requires a steps array");
      const token = {};
      this.callbacks.set(token, {
        steps: steps as CallbackStep[],
        nextStep: 0,
      });
      return token;
    }

    return input as JSONType;
  }
}

function runCase(builtin: string, tc: TestCase): void {
  const harness = new DirectBuiltinHarness();
  const args = harness.decodeArgs(tc.args);

  if ("throws" in tc.outcome) {
    let thrown: unknown;
    try {
      harness.invoke(builtin, args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "expected builtin invocation to throw").toBeDefined();
    expect(errorMessage(thrown)).toContain(tc.outcome.throws.messageIncludes);
  } else {
    expect(harness.invoke(builtin, args)).toEqual(tc.outcome.returns);
  }

  harness.verifyFixtures();
  if (tc.observations?.logs !== undefined) {
    expect(harness.logs).toEqual(tc.observations.logs);
  }
  if (tc.observations?.meter?.charged !== undefined) {
    expect(harness.charged).toBe(tc.observations.meter.charged);
  }
  if (tc.observations?.meter?.guardedSizes !== undefined) {
    expect(harness.guardedSizes).toEqual(tc.observations.meter.guardedSizes);
  }
}

function collectCaseFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectCaseFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

function validateSuite(path: string, root: string, value: unknown): asserts value is TestSuite {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  if (value.$schema !== "../../builtin.schema.json") {
    throw new Error(`${path}: expected $schema to be "../../builtin.schema.json"`);
  }
  if (typeof value.builtin !== "string" || value.builtin.length === 0) {
    throw new Error(`${path}: expected a non-empty builtin name`);
  }
  if (typeof value.description !== "string" || value.description.length === 0) {
    throw new Error(`${path}: expected a non-empty description`);
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error(`${path}: expected at least one case`);
  }

  const fileBuiltin = basename(path, ".json");
  if (value.builtin !== fileBuiltin) {
    throw new Error(`${path}: builtin must match file name ${JSON.stringify(fileBuiltin)}`);
  }

  const tableEntry = loadBuiltinTable().builtins[value.builtin];
  if (tableEntry === undefined) {
    throw new Error(`${path}: ${JSON.stringify(value.builtin)} is not in the builtin registry`);
  }

  const relativeDir = relative(root, dirname(path));
  if (relativeDir.includes(sep)) {
    throw new Error(`${path}: builtin cases must be exactly one category directory deep`);
  }
  if (tableEntry.category !== relativeDir) {
    throw new Error(
      `${path}: category ${JSON.stringify(relativeDir)} does not match registry category ${JSON.stringify(tableEntry.category)}`,
    );
  }
}

export function runAllBuiltinCases(dir: string): void {
  for (const path of collectCaseFiles(dir)) {
    const suite: unknown = JSON.parse(readFileSync(path, "utf8"));
    validateSuite(path, dir, suite);

    describe(`${suite.builtin}: ${suite.description}`, () => {
      for (const tc of suite.cases) {
        test(tc.description, () => runCase(suite.builtin, tc));
      }
    });
  }
}
