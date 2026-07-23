import { readFileSync } from "fs";
import type { EnvironmentContract } from "../../environment/types";

export const DEPLOYMENT_PROFILE_VERSION = 1;

export type PortableExecutionLimits = {
  maxCallDepth?: number;
  maxFuel?: number;
  maxValueSize?: number;
};

export type LiveDeploymentProfile = {
  version: number;
  mode: "live";
  effects: string[];
  limits?: PortableExecutionLimits;
};

export type DurableDeploymentProfile = {
  version: number;
  mode: "durable";
  deploymentId: string;
  effects: Record<string, "inline" | "suspending">;
  limits?: PortableExecutionLimits;
};

export type DeploymentProfile = LiveDeploymentProfile | DurableDeploymentProfile;

export class DeploymentProfileValidationError extends Error {
  readonly code = "INVALID_DEPLOYMENT_PROFILE";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "DeploymentProfileValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new DeploymentProfileValidationError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unsupported field");
  }
}

function validateLimits(value: unknown): void {
  const limits = object(value, "profile.limits");
  onlyKeys(limits, new Set(["maxCallDepth", "maxFuel", "maxValueSize"]), "profile.limits");
  for (const key of Object.keys(limits)) {
    const limit = limits[key];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
      fail(`profile.limits.${key}`, "expected a non-negative integer");
    }
  }
}

export function validateDeploymentProfile(
  value: unknown,
  contract?: EnvironmentContract,
): asserts value is DeploymentProfile {
  const profile = object(value, "profile");
  if (profile.version !== DEPLOYMENT_PROFILE_VERSION) {
    fail(
      "profile.version",
      typeof profile.version === "number"
        ? `unsupported profile version ${profile.version}; expected ${DEPLOYMENT_PROFILE_VERSION}`
        : "expected an integer",
    );
  }
  if (profile.mode !== "live" && profile.mode !== "durable") {
    fail("profile.mode", 'expected "live" or "durable"');
  }
  onlyKeys(
    profile,
    new Set(
      profile.mode === "live"
        ? ["version", "mode", "effects", "limits"]
        : ["version", "mode", "deploymentId", "effects", "limits"],
    ),
    "profile",
  );
  if ("limits" in profile) validateLimits(profile.limits);

  const declaredEffects = new Set(Object.keys(contract?.effects ?? {}));
  const validateEffectName = (name: unknown, path: string, seen: Set<string>): string => {
    if (typeof name !== "string" || name.length === 0) fail(path, "expected a non-empty string");
    if (name === "raise") fail(path, '"raise" is intrinsic and cannot be selected');
    if (seen.has(name)) fail(path, `duplicate effect "${name}"`);
    if (contract !== undefined && !declaredEffects.has(name)) {
      fail(path, `effect "${name}" is not declared by the contract`);
    }
    seen.add(name);
    return name;
  };

  const seen = new Set<string>();
  if (profile.mode === "live") {
    if (!Array.isArray(profile.effects)) fail("profile.effects", "expected an array");
    profile.effects.forEach((name, index) =>
      validateEffectName(name, `profile.effects[${index}]`, seen),
    );
    return;
  }

  if (typeof profile.deploymentId !== "string" || profile.deploymentId.length === 0) {
    fail("profile.deploymentId", "expected a non-empty string");
  }
  const effects = object(profile.effects, "profile.effects");
  for (const [name, mode] of Object.entries(effects)) {
    validateEffectName(name, `profile.effects.${name}`, seen);
    if (mode !== "inline" && mode !== "suspending") {
      fail(`profile.effects.${name}`, 'expected "inline" or "suspending"');
    }
  }
}

export function loadDeploymentProfile(
  path: string,
  contract?: EnvironmentContract,
): DeploymentProfile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateDeploymentProfile(parsed, contract);
  return parsed;
}
