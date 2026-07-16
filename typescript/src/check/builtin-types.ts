import type { JSONType } from "../types";
import type { EffectManifest } from "../effects";
import type { Defs, Schema } from "./schema";

type TVarNode = { $tvar: string };
type CallableSignature = {
  typeParams?: string[];
  params: Schema[];
  rest?: Schema;
  returns: Schema;
};
type CallableEntry = { signatures: CallableSignature[]; rule?: string };
type CallableTable = { $defs?: Defs; builtins: Record<string, CallableEntry> };

// A per-call-site type-variable environment (T, U, … → their inferred schema).
type Bindings = Record<string, Schema>;

type CallableTypeRuleRequest = {
  name: string;
  args: JSONType[];
  fallbackResult: Schema;
  fallbackMatched: boolean;
};

type RuleDiagnosticOptions = {
  argumentIndex?: number;
  path?: string[];
  expected?: Schema;
  actual?: Schema;
};

// The intentionally small, versioned checker surface available to type rules.
// Rules receive no mutable type environment or diagnostics array.
type CallableTypeRuleServicesV1 = {
  apiVersion: 1;
  defs: Readonly<Defs>;
  effects?: Readonly<EffectManifest>;
  synthArgument: (index: number) => Schema;
  checkArgument: (index: number, expected: Schema) => void;
  contextualCheckArgument: (index: number, expected: Schema) => void;
  contextualTypeCallback: (index: number, expectedFn: Schema) => Schema | null;
  resolveSchema: (schema: Schema) => Schema;
  instantiateSchema: (schema: Schema, bindings: Bindings) => Schema;
  reportError: (message: string, options?: RuleDiagnosticOptions) => void;
  reportAnyDegradation: (reason: string) => void;
  reportCoverageDegradation: (reason: string) => void;
};

type CallableTypeRuleApplyV1 = (
  request: CallableTypeRuleRequest,
  services: CallableTypeRuleServicesV1,
) => Schema;
type CallableTypeRuleV1 = {
  contextualArguments?: readonly number[];
  apply: CallableTypeRuleApplyV1;
};
type CallableTypeRuleRegistry = Record<string, CallableTypeRuleV1>;

export type {
  TVarNode,
  CallableSignature,
  CallableEntry,
  CallableTable,
  Bindings,
  CallableTypeRuleRequest,
  RuleDiagnosticOptions,
  CallableTypeRuleServicesV1,
  CallableTypeRuleApplyV1,
  CallableTypeRuleV1,
  CallableTypeRuleRegistry,
};
