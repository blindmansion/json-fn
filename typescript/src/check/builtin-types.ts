import type { JSONType } from "../types";
import type { EffectManifest } from "../effects";
import type { Defs, Schema } from "./schema";

type TVarNode = { $tvar: string };
type BuiltinSig = { typeParams?: string[]; params: Schema[]; rest?: Schema; returns: Schema };
type BuiltinEntry = { signatures: BuiltinSig[]; rule?: string };
type BuiltinTable = { $defs?: Defs; builtins: Record<string, BuiltinEntry> };

// A per-call-site type-variable environment (T, U, … → their inferred schema).
type Bindings = Record<string, Schema>;

type BuiltinTypeRuleRequest = {
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
type BuiltinTypeRuleServicesV1 = {
  apiVersion: 1;
  defs: Readonly<Defs>;
  effects?: Readonly<EffectManifest>;
  synthArgument: (index: number) => Schema;
  checkArgument: (index: number, expected: Schema) => void;
  contextualTypeCallback: (index: number, expectedFn: Schema) => Schema | null;
  resolveSchema: (schema: Schema) => Schema;
  instantiateSchema: (schema: Schema, bindings: Bindings) => Schema;
  reportError: (message: string, options?: RuleDiagnosticOptions) => void;
  reportAnyDegradation: (reason: string) => void;
  reportCoverageDegradation: (reason: string) => void;
};

type BuiltinTypeRuleV1 = (
  request: BuiltinTypeRuleRequest,
  services: BuiltinTypeRuleServicesV1,
) => Schema;
type BuiltinTypeRuleRegistry = Record<string, BuiltinTypeRuleV1>;

export type {
  TVarNode,
  BuiltinSig,
  BuiltinEntry,
  BuiltinTable,
  Bindings,
  BuiltinTypeRuleRequest,
  RuleDiagnosticOptions,
  BuiltinTypeRuleServicesV1,
  BuiltinTypeRuleV1,
  BuiltinTypeRuleRegistry,
};
