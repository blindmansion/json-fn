import type { CallableEntry } from "../check/builtin-types";
import type { Defs, Schema } from "../schema/schema.ts";
import type { EffectManifest } from "./effect-types";

export type EntryReturn = Schema | { task: Schema };

export type EntryContract = {
  name: string;
  required: Schema[];
  optional: Schema[];
  returns: EntryReturn;
};

export type Environment = {
  $defs?: Defs;
  functions?: Record<string, CallableEntry>;
  effects?: EffectManifest;
  entry: EntryContract;
};
