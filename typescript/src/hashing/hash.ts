/**
 * Domain-separated, versioned hashes over canonical JSON bytes (roadmap
 * Phase 3; owning plan:
 * plans/content-addressing/content-addressed-values.md).
 *
 * Every hash lives in exactly one versioned domain. The domain string is part
 * of the hash *input* (so equal bytes hash differently under different
 * domains) and part of the rendered *address* (so an address is
 * self-describing about its domain, version, and digest algorithm). Rendered
 * addresses look like:
 *
 *     jfn:value:v1:sha256:9f2c...
 *
 * Distinct domains are distinct TypeScript branded types: a `ValueHash`, a
 * `BlobHash`, and the deployment/component hashes cannot be substituted for
 * one another merely because their digest algorithms match.
 *
 * - `ValueHash` (`jfn:value:v1`) is the semantic identity of one complete
 *   accepted guest value: the digest of its canonical JCS-style bytes. It is
 *   independent of chunk thresholds and physical blob layout by construction
 *   — nothing about storage participates in the input.
 * - `BlobHash` (`jfn:blob:v1`) addresses one physical blob payload (the
 *   at-rest codec of Phase 4B). The domain is pinned now so the two hash
 *   spaces can never collide; the codec itself is not part of Phase 3.
 *
 * SHA-256 is the v1 digest for every domain: it exists in the standard
 * library of all four implementations, which the cross-runtime test vectors
 * in `spec/hash-cases/` rely on. A future algorithm change is a new domain
 * version, never a silent re-interpretation of existing addresses.
 */

import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-json";

declare const HASH_DOMAIN: unique symbol;

/** A rendered hash address branded by its versioned domain. */
export type HashAddress<Domain extends string> = string & { readonly [HASH_DOMAIN]: Domain };

export const VALUE_HASH_DOMAIN = "jfn:value:v1";
export const BLOB_HASH_DOMAIN = "jfn:blob:v1";

export type ValueHash = HashAddress<typeof VALUE_HASH_DOMAIN>;
export type BlobHash = HashAddress<typeof BLOB_HASH_DOMAIN>;

/**
 * Digest `payload` inside `domain`. The input is the UTF-8 bytes of the
 * domain string, one `\n` separator (domains never contain newlines), then
 * the payload bytes; the address records the domain and algorithm.
 */
export function hashWithDomain<Domain extends string>(
  domain: Domain,
  payload: Uint8Array,
): HashAddress<Domain> {
  const digest = createHash("sha256");
  digest.update(`${domain}\n`);
  digest.update(payload);
  return `${domain}:sha256:${digest.digest("hex")}` as HashAddress<Domain>;
}

/**
 * Semantic identity of one complete accepted guest value. Structurally equal
 * values (per structural `eq`, which ignores object key order) hash equal;
 * expression-shaped guest data hashes as the plain structure it is — the
 * program normalizer is never applied here.
 */
export function valueHash(value: unknown): ValueHash {
  return hashWithDomain(VALUE_HASH_DOMAIN, canonicalJsonBytes(value));
}

/**
 * Address of one physical blob payload. Callers own the versioned payload
 * encoding (codec and chunk-layout version are part of the payload, not this
 * function); this pins the domain so blob addresses can never be confused
 * with semantic value hashes.
 */
export function blobHash(payload: Uint8Array): BlobHash {
  return hashWithDomain(BLOB_HASH_DOMAIN, payload);
}
