import type { JSONType } from "../../types";

export type DurableEffectMode = "inline" | "suspending";

export type DurableEffectContext = {
  workflowId: string;
  effectId: string;
};

export type DurableCapability = (
  context: DurableEffectContext,
  ...args: JSONType[]
) => Promise<JSONType> | JSONType;
