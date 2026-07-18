import type { Schema } from "../schema/schema.ts";

export type EffectSignature = { params: Schema[]; returns: Schema };
export type EffectManifest = Record<string, EffectSignature>;
