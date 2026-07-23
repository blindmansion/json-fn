import { EFFECTS_BINDING } from "../environment/effects";
import type { EnvironmentContract } from "../environment/types";
import { TASK_TAG } from "../task";
import type { JSONType } from "../types";
import type { DeploymentProfile } from "./deployment";

/** Conservative, non-fatal analysis of a deployment's possible host effects. */
export type DeploymentCapabilityAnalysis = {
  possibleNames: string[];
  dynamic: boolean;
  profileBindings: string[];
  uncovered: string[];
};

export function analyzeDeploymentCapabilities(options: {
  module: JSONType;
  contract: Pick<EnvironmentContract, "effects">;
  profile: DeploymentProfile;
}): DeploymentCapabilityAnalysis {
  const { module: node, contract, profile } = options;
  const names = new Set<string>();
  let dynamic = false;

  const walk = (value: JSONType): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;

    if (typeof value[TASK_TAG] === "string" && value[TASK_TAG] === "effect") {
      const name = value.name;
      if (typeof name === "string") names.add(name);
      else dynamic = true;
    }

    const callee = value.$call;
    const callArgs = value.$args;
    if (typeof callee === "string" && Array.isArray(callArgs)) {
      if (callee === "perform") {
        const name = callArgs[0];
        if (typeof name === "string") names.add(name);
        else dynamic = true;
      } else if (callee === "raise") {
        names.add("raise");
      }
    } else if (callee !== undefined && Array.isArray(callArgs)) {
      const path = effectAccessPath(callee);
      if (path === "dynamic") {
        dynamic = true;
      } else if (path !== null && path.length > 0) {
        const name = path.join(".");
        if (contract.effects?.[name] !== undefined) names.add(name);
      }
    }

    for (const key of Object.keys(value)) walk(value[key]!);
  };

  walk(node);
  names.delete("raise");
  const profileBindings =
    profile.mode === "live" ? [...profile.effects] : Object.keys(profile.effects);
  const bound = new Set(profileBindings);
  const possibleNames = [...names].sort();
  const uncovered = new Set(possibleNames.filter((name) => !bound.has(name)));
  if (dynamic) {
    for (const name of Object.keys(contract.effects ?? {})) {
      if (!bound.has(name)) uncovered.add(name);
    }
  }
  return {
    possibleNames,
    dynamic,
    profileBindings: profileBindings.sort(),
    uncovered: [...uncovered].sort(),
  };
}

function effectAccessPath(node: JSONType): string[] | "dynamic" | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
  if (node.$var === EFFECTS_BINDING) return [];
  if (!("$get" in node) || !("$from" in node)) return null;

  const base = effectAccessPath(node.$from!);
  if (base === null || base === "dynamic") return base;
  const key = node.$get;
  if (typeof key === "string") return [...base, key];
  if (Array.isArray(key) && key.every((segment) => typeof segment === "string")) {
    return [...base, ...(key as string[])];
  }
  return "dynamic";
}
