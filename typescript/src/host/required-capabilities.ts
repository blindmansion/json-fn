import { EFFECTS_BINDING } from "../environment/effects";
import type { Environment } from "../environment/types";
import { TASK_TAG } from "../task";
import type { JSONType } from "../types";

/** Static over-approximation of capabilities a module or task may require. */
export type RequiredCapabilities = { names: string[]; dynamic: boolean };

export function requiredCapabilities(
  node: JSONType,
  environment?: Pick<Environment, "effects">,
): RequiredCapabilities {
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
    } else if (callee !== undefined && Array.isArray(callArgs) && environment !== undefined) {
      const path = effectAccessPath(callee);
      if (path === "dynamic") {
        dynamic = true;
      } else if (path !== null && path.length > 0) {
        const name = path.join(".");
        if (environment.effects?.[name] !== undefined) names.add(name);
      }
    }

    for (const key of Object.keys(value)) walk(value[key]!);
  };

  walk(node);
  return { names: [...names].sort(), dynamic };
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
