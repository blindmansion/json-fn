/**
 * Component and aggregate deployment identity hash helpers (roadmap Phase 3;
 * consumer plan: plans/content-addressing/module-identity-pinning.md).
 *
 * These are pure functions over plain JSON inputs. Wiring them into
 * `prepareDeployment`, workflow records, and the durable driver is Phase 4A
 * (module identity pinning); nothing here touches the host layer.
 *
 * Two module hashes, two roles (settled in Phase 0):
 *
 * - `moduleArtifactHash` digests the canonical-JSON module *exactly as
 *   reviewed* — after shorthand parsing, before program normalization. It is
 *   provenance/diagnostic metadata and must never be an enforcement input.
 * - `moduleHash` digests the module after the context-sensitive program
 *   normalizer (`src/shorthand/normalize.ts`), so semantically neutral
 *   respellings (redundant-`$raw` removal, hoisting) cannot create distinct
 *   identities. Enforcement keys on this hash only.
 *
 * This is the only place the program normalizer participates in hashing. It
 * applies to the authored module — program syntax — never to arbitrary guest
 * values; the environment contract and profile projection are data documents
 * and are canonically encoded as-is.
 */

import type { JSONType } from "../types";
import { normalizeModule } from "../shorthand/normalize";
import { canonicalJsonBytes } from "./canonical-json";
import { hashWithDomain, type HashAddress } from "./hash";

export const MODULE_HASH_DOMAIN = "jfn:module:v1";
export const MODULE_ARTIFACT_HASH_DOMAIN = "jfn:module-artifact:v1";
export const CONTRACT_HASH_DOMAIN = "jfn:contract:v1";
export const BUILTIN_TABLE_HASH_DOMAIN = "jfn:builtins:v1";
export const PROFILE_HASH_DOMAIN = "jfn:profile:v1";
export const DEPLOYMENT_HASH_DOMAIN = "jfn:deployment:v1";

export type ModuleHash = HashAddress<typeof MODULE_HASH_DOMAIN>;
export type ModuleArtifactHash = HashAddress<typeof MODULE_ARTIFACT_HASH_DOMAIN>;
export type ContractHash = HashAddress<typeof CONTRACT_HASH_DOMAIN>;
export type BuiltinTableHash = HashAddress<typeof BUILTIN_TABLE_HASH_DOMAIN>;
export type ProfileHash = HashAddress<typeof PROFILE_HASH_DOMAIN>;
export type DeploymentHash = HashAddress<typeof DEPLOYMENT_HASH_DOMAIN>;

/**
 * Exact hash of the reviewed authored artifact: the canonical-JSON module as
 * parsed, before program normalization. Answers "is this byte-for-byte the
 * program that was approved?" independently of any normalizer version.
 */
export function moduleArtifactHash(canonicalModule: JSONType): ModuleArtifactHash {
  return hashWithDomain(MODULE_ARTIFACT_HASH_DOMAIN, canonicalJsonBytes(canonicalModule));
}

/**
 * Normalized semantic module hash: the authored module after program
 * normalization, including `$types`, before contract-derived effect bindings
 * are injected. This is the module component that identity enforcement
 * compares.
 */
export function moduleHash(canonicalModule: JSONType): ModuleHash {
  return hashWithDomain(MODULE_HASH_DOMAIN, canonicalJsonBytes(normalizeModule(canonicalModule)));
}

/** Hash of the portable environment-contract document. */
export function contractHash(contract: JSONType): ContractHash {
  return hashWithDomain(CONTRACT_HASH_DOMAIN, canonicalJsonBytes(contract));
}

/**
 * Hash of the full builtin signature table plus the explicit engine/stdlib
 * semantic version. The version is an identity input because a behavior
 * change to an existing builtin is invisible to signature hashing.
 */
export function builtinTableHash(
  signatureTable: JSONType,
  engineVersion: string,
): BuiltinTableHash {
  return hashWithDomain(
    BUILTIN_TABLE_HASH_DOMAIN,
    canonicalJsonBytes({ engineVersion, signatureTable }),
  );
}

/**
 * Hash of the deployment profile's semantic projection. The caller supplies
 * the projection (for profile v1: mode, effect selection and
 * inline/suspending classification, and the closed portable limits) — the
 * projection rule itself is owned by module-identity pinning (Phase 4A).
 */
export function profileProjectionHash(projection: JSONType): ProfileHash {
  return hashWithDomain(PROFILE_HASH_DOMAIN, canonicalJsonBytes(projection));
}

/**
 * The component hashes aggregated into one executable-world identity.
 *
 * The authored-artifact hash is deliberately absent: enforcement keys on the
 * normalized module hash only, and the artifact hash must never be an
 * enforcement input — otherwise a semantically neutral respelling
 * (reformatting, redundant-`$raw` removal) would change the aggregate and
 * reject in-flight workflows. Identity manifests (Phase 4A) carry the
 * artifact hash *beside* the aggregate as provenance/diagnostic metadata.
 */
export type DeploymentIdentityComponents = {
  module: ModuleHash;
  contract: ContractHash;
  builtins: BuiltinTableHash;
  profile: ProfileHash;
};

/**
 * Aggregate executable-world identity: the hash of the canonical encoding of
 * the component-hash record. Enforcement compares this aggregate; component
 * hashes let drift diagnostics name the changed component.
 */
export function deploymentHash(components: DeploymentIdentityComponents): DeploymentHash {
  return hashWithDomain(DEPLOYMENT_HASH_DOMAIN, canonicalJsonBytes(components));
}
