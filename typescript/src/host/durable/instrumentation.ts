// Phase 0 measurement instrumentation for the durable host.
//
// The implementation roadmap requires non-sensitive measurements of
// representative durable workloads before any storage or evaluator complexity
// (content-addressed blobs, structural sharing) is added:
//
// - serialized logical record sizes by workflow state;
// - repeated subtrees and closure-substitution expansion;
// - record changes between suspensions;
// - hydration time and peak memory; and
// - expected blob read/write amplification under candidate thresholds.
//
// Everything here is observational: `instrumentWorkflowStore` decorates a
// `WorkflowStore` without changing driver semantics, and the report contains
// only counts, byte sizes, durations, and ratios — never workflow IDs, effect
// names, or guest values.

import type { JSONType } from "../../types";
import type { ClaimOutcome, WorkflowStore } from "./store";
import {
  hydrateWorkflowRecord,
  serializeWorkflowRecord,
  type WorkflowRecord,
} from "./workflow-record";

/** Serialized size of one blob reference in the simulated chunked encoding. */
const BLOB_REF_BYTES = Buffer.byteLength(`{"@blob":"${"0".repeat(64)}"}`);

/** Candidate chunking thresholds from the content-addressing plan (1–4 KB). */
const DEFAULT_BLOB_THRESHOLDS_BYTES = [512, 1024, 2048, 4096];

export type StatSummary = {
  count: number;
  total: number;
  min: number;
  max: number;
  mean: number;
};

export type BlobbingEstimate = {
  /** Subtrees whose encoding exceeds this many bytes become blobs. */
  thresholdBytes: number;
  /** Serialized size of one blob reference. */
  refBytes: number;
  /** Total bytes of full record writes without blobbing (the baseline). */
  logicalWriteBytes: number;
  /** Total bytes of inline record roots written under blobbing. */
  rootWriteBytes: number;
  /** Total bytes of new (not previously stored) blobs written. */
  blobWriteBytes: number;
  /** (root + new blob bytes) / logical bytes; below 1 means dedup wins. */
  writeAmplification: number;
  /** Distinct blobs in the simulated store at the end of the run. */
  storedBlobCount: number;
  /** Total bytes of distinct blobs in the simulated store. */
  storedBlobBytes: number;
  /** Store reads needed to hydrate one record (1 root + distinct blobs). */
  readOpsPerHydration: StatSummary;
  /** (root + referenced blob bytes) / logical bytes when hydrating. */
  readAmplification: number;
};

export type DurableInstrumentationReport = {
  /** Serialized size of one blob reference used by the dedup estimates. */
  blobRefBytes: number;
  records: {
    count: number;
    bytes: StatSummary;
    nodes: StatSummary;
    depth: StatSummary;
    byStatus: Partial<Record<WorkflowRecord["status"], { count: number; bytes: StatSummary }>>;
  };
  duplication: {
    /** Repeated composite subtrees larger than one blob reference. */
    duplicateSubtreeInstances: number;
    duplicateSubtreeBytes: number;
    /** Record bytes if each repeated subtree were stored once. */
    dedupedBytes: StatSummary;
    /** bytes / dedupedBytes per record; above 1 means duplication exists. */
    duplicationRatio: StatSummary;
    /** The pending continuation closure, where substitution expands state. */
    continuation: {
      count: number;
      bytes: StatSummary;
      shareOfRecordBytes: StatSummary;
      duplicationRatio: StatSummary;
    };
  };
  /** Consecutive suspended records of the same workflow. */
  betweenSuspensions: {
    count: number;
    previousBytes: StatSummary;
    nextBytes: StatSummary;
    grownBytes: StatSummary;
    /** Share of the next record covered by subtrees of the previous one. */
    reusedBytesRatio: StatSummary;
  };
  hydration: {
    count: number;
    durationMs: StatSummary;
    /** Heap delta across one hydration; GC noise makes this approximate. */
    approximateHeapDeltaBytes: StatSummary;
    /** Largest resident set size sampled during observations. */
    peakRssBytes: number;
  };
  blobbing: BlobbingEstimate[];
};

export type DurableInstrumentation = {
  /** Record one persisted record revision. */
  observeRecord(record: WorkflowRecord): void;
  /** Produce the JSON-serializable, non-sensitive summary. */
  report(): DurableInstrumentationReport;
};

export type DurableInstrumentationOptions = {
  /** Candidate chunking thresholds in bytes; defaults to 512–4096. */
  blobThresholdsBytes?: number[];
};

export function createDurableInstrumentation(
  options: DurableInstrumentationOptions = {},
): DurableInstrumentation {
  const thresholds = options.blobThresholdsBytes ?? DEFAULT_BLOB_THRESHOLDS_BYTES;
  return new Instrumentation(thresholds);
}

/**
 * Decorate a store so every persisted record revision (create, transition,
 * and successful claim) is observed. Reads and outcomes are untouched.
 */
export function instrumentWorkflowStore(
  store: WorkflowStore,
  instrumentation: DurableInstrumentation,
): WorkflowStore {
  return {
    async create(record: WorkflowRecord): Promise<void> {
      await store.create(record);
      instrumentation.observeRecord(record);
    },
    async transition(expectedRevision: number, record: WorkflowRecord): Promise<void> {
      await store.transition(expectedRevision, record);
      instrumentation.observeRecord(record);
    },
    async claim(workflowId: string, effectId: string, result: JSONType): Promise<ClaimOutcome> {
      const outcome = await store.claim(workflowId, effectId, result);
      if ("claimed" in outcome) instrumentation.observeRecord(outcome.claimed);
      return outcome;
    },
    read: (workflowId) => store.read(workflowId),
    listNonterminal: () => store.listNonterminal(),
  };
}

class Stat {
  #count = 0;
  #total = 0;
  #min = Infinity;
  #max = -Infinity;

  push(value: number): void {
    this.#count += 1;
    this.#total += value;
    if (value < this.#min) this.#min = value;
    if (value > this.#max) this.#max = value;
  }

  summary(): StatSummary {
    if (this.#count === 0) return { count: 0, total: 0, min: 0, max: 0, mean: 0 };
    return {
      count: this.#count,
      total: this.#total,
      min: this.#min,
      max: this.#max,
      mean: this.#total / this.#count,
    };
  }
}

type CanonIndex = {
  /** Canonical (JSON.stringify-equivalent) text per composite subtree. */
  canons: Map<object, string>;
  nodes: number;
  depth: number;
};

/**
 * Walk a parsed JSON tree bottom-up, producing the canonical serialization of
 * every composite subtree. The assembled text matches `JSON.stringify` on
 * `JSON.parse` output byte for byte, so the root canon length equals the
 * stored record size.
 */
function buildCanonIndex(root: JSONType): CanonIndex {
  const canons = new Map<object, string>();
  let nodes = 0;
  let maxDepth = 0;
  const walk = (value: JSONType, depth: number): string => {
    nodes += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    let canon: string;
    if (Array.isArray(value)) {
      canon = `[${value.map((item) => walk(item, depth + 1)).join(",")}]`;
    } else {
      const parts: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        parts.push(`${JSON.stringify(key)}:${walk(child, depth + 1)}`);
      }
      canon = `{${parts.join(",")}}`;
    }
    canons.set(value, canon);
    return canon;
  };
  walk(root, 1);
  return { canons, nodes, depth: maxDepth };
}

/**
 * Count top-most repeated composite subtrees larger than one blob reference.
 * Each repeat is counted at its full serialized size and not descended into,
 * matching what reference-based structural sharing could save.
 */
function measureDuplication(
  root: JSONType,
  canons: Map<object, string>,
): { instances: number; bytes: number } {
  const seen = new Set<string>();
  let instances = 0;
  let bytes = 0;
  const visit = (value: JSONType): void => {
    if (value === null || typeof value !== "object") return;
    const canon = canons.get(value)!;
    if (Buffer.byteLength(canon) > BLOB_REF_BYTES) {
      if (seen.has(canon)) {
        instances += 1;
        bytes += Buffer.byteLength(canon);
        return;
      }
      seen.add(canon);
    }
    visitChildren(value, visit);
  };
  visit(root);
  return { instances, bytes };
}

/**
 * Measure how many bytes of `root` are covered by composite subtrees that
 * already existed anywhere in the previous record (top-down, no descent into
 * reused subtrees).
 */
function measureReuse(
  previousCanons: ReadonlySet<string>,
  root: JSONType,
  canons: Map<object, string>,
): number {
  let reused = 0;
  const visit = (value: JSONType): void => {
    if (value === null || typeof value !== "object") return;
    const canon = canons.get(value)!;
    if (Buffer.byteLength(canon) > BLOB_REF_BYTES && previousCanons.has(canon)) {
      reused += Buffer.byteLength(canon);
      return;
    }
    visitChildren(value, visit);
  };
  visit(root);
  return reused;
}

function visitChildren(
  value: JSONType[] | { [key: string]: JSONType },
  visit: (child: JSONType) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
  } else {
    for (const child of Object.values(value)) visit(child);
  }
}

function shareableCanonSet(canons: Map<object, string>): Set<string> {
  const set = new Set<string>();
  for (const canon of canons.values()) {
    if (Buffer.byteLength(canon) > BLOB_REF_BYTES) set.add(canon);
  }
  return set;
}

/**
 * Simulate the leaves-first chunked encoding from the content-addressing
 * plan: when a subtree's encoding (with already-blobbed children replaced by
 * refs) exceeds the threshold, it becomes a blob and its parent sees only the
 * fixed-size reference. Blob identity is the encoded content, so identical
 * subtrees dedup across records and revisions.
 */
class BlobSimulation {
  readonly threshold: number;
  readonly #blobIdsByContent = new Map<string, string>();
  readonly #readOps = new Stat();
  #storedBlobBytes = 0;
  #logicalWriteBytes = 0;
  #rootWriteBytes = 0;
  #blobWriteBytes = 0;
  #readBytes = 0;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  observe(root: JSONType, logicalBytes: number): void {
    const referenced = new Map<string, number>();
    const encode = (value: JSONType): string => {
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      let encoded: string;
      if (Array.isArray(value)) {
        encoded = `[${value.map(encode).join(",")}]`;
      } else {
        const parts: string[] = [];
        for (const [key, child] of Object.entries(value)) {
          parts.push(`${JSON.stringify(key)}:${encode(child)}`);
        }
        encoded = `{${parts.join(",")}}`;
      }
      const bytes = Buffer.byteLength(encoded);
      if (bytes <= this.threshold) return encoded;
      let id = this.#blobIdsByContent.get(encoded);
      if (id === undefined) {
        id = this.#blobIdsByContent.size.toString(16).padStart(64, "0");
        this.#blobIdsByContent.set(encoded, id);
        this.#storedBlobBytes += bytes;
        this.#blobWriteBytes += bytes;
      }
      referenced.set(id, bytes);
      return `{"@blob":"${id}"}`;
    };

    const rootBytes = Buffer.byteLength(encode(root));
    this.#logicalWriteBytes += logicalBytes;
    this.#rootWriteBytes += rootBytes;
    let referencedBytes = 0;
    for (const bytes of referenced.values()) referencedBytes += bytes;
    this.#readOps.push(1 + referenced.size);
    this.#readBytes += rootBytes + referencedBytes;
  }

  estimate(): BlobbingEstimate {
    const logical = this.#logicalWriteBytes;
    return {
      thresholdBytes: this.threshold,
      refBytes: BLOB_REF_BYTES,
      logicalWriteBytes: logical,
      rootWriteBytes: this.#rootWriteBytes,
      blobWriteBytes: this.#blobWriteBytes,
      writeAmplification:
        logical === 0 ? 0 : (this.#rootWriteBytes + this.#blobWriteBytes) / logical,
      storedBlobCount: this.#blobIdsByContent.size,
      storedBlobBytes: this.#storedBlobBytes,
      readOpsPerHydration: this.#readOps.summary(),
      readAmplification: logical === 0 ? 0 : this.#readBytes / logical,
    };
  }
}

class Instrumentation implements DurableInstrumentation {
  readonly #blobSimulations: BlobSimulation[];

  readonly #bytes = new Stat();
  readonly #nodes = new Stat();
  readonly #depth = new Stat();
  readonly #bytesByStatus = new Map<WorkflowRecord["status"], Stat>();

  #duplicateInstances = 0;
  #duplicateBytes = 0;
  readonly #dedupedBytes = new Stat();
  readonly #duplicationRatio = new Stat();
  readonly #continuationBytes = new Stat();
  readonly #continuationShare = new Stat();
  readonly #continuationDuplicationRatio = new Stat();

  readonly #lastSuspended = new Map<string, { bytes: number; canons: Set<string> }>();
  readonly #previousSuspendedBytes = new Stat();
  readonly #nextSuspendedBytes = new Stat();
  readonly #grownBytes = new Stat();
  readonly #reusedBytesRatio = new Stat();

  readonly #hydrationMs = new Stat();
  readonly #hydrationHeapDelta = new Stat();
  #peakRssBytes = 0;

  constructor(thresholds: number[]) {
    this.#blobSimulations = thresholds.map((threshold) => new BlobSimulation(threshold));
  }

  observeRecord(record: WorkflowRecord): void {
    const serialized = serializeWorkflowRecord(record);
    const bytes = Buffer.byteLength(serialized);

    // Hydration time and (approximate) memory: measure the real hydration
    // path — parse, validate, and inertness restoration — on the exact
    // serialized text a store would hold.
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    const hydrated = hydrateWorkflowRecord(serialized);
    this.#hydrationMs.push(performance.now() - start);
    const usage = process.memoryUsage();
    this.#hydrationHeapDelta.push(usage.heapUsed - heapBefore);
    if (usage.rss > this.#peakRssBytes) this.#peakRssBytes = usage.rss;

    // All structural analysis runs on the parsed tree so canonical subtree
    // texts add up to the stored bytes exactly.
    const parsed = hydrated as unknown as JSONType;
    const { canons, nodes, depth } = buildCanonIndex(parsed);

    this.#bytes.push(bytes);
    this.#nodes.push(nodes);
    this.#depth.push(depth);
    let statusStat = this.#bytesByStatus.get(hydrated.status);
    if (statusStat === undefined) {
      statusStat = new Stat();
      this.#bytesByStatus.set(hydrated.status, statusStat);
    }
    statusStat.push(bytes);

    const duplication = measureDuplication(parsed, canons);
    this.#duplicateInstances += duplication.instances;
    this.#duplicateBytes += duplication.bytes;
    const dedupedBytes = bytes - duplication.bytes + duplication.instances * BLOB_REF_BYTES;
    this.#dedupedBytes.push(dedupedBytes);
    this.#duplicationRatio.push(dedupedBytes === 0 ? 1 : bytes / dedupedBytes);

    const resume = pendingResumeOf(hydrated);
    if (resume !== undefined) {
      const resumeBytes = Buffer.byteLength(canons.get(resume as object) ?? JSON.stringify(resume));
      this.#continuationBytes.push(resumeBytes);
      this.#continuationShare.push(bytes === 0 ? 0 : resumeBytes / bytes);
      const resumeDuplication = measureDuplication(resume, canons);
      const resumeDeduped =
        resumeBytes - resumeDuplication.bytes + resumeDuplication.instances * BLOB_REF_BYTES;
      this.#continuationDuplicationRatio.push(
        resumeDeduped === 0 ? 1 : resumeBytes / resumeDeduped,
      );
    }

    if (hydrated.status === "suspended") {
      const previous = this.#lastSuspended.get(hydrated.workflowId);
      if (previous !== undefined) {
        this.#previousSuspendedBytes.push(previous.bytes);
        this.#nextSuspendedBytes.push(bytes);
        this.#grownBytes.push(bytes - previous.bytes);
        const reused = measureReuse(previous.canons, parsed, canons);
        this.#reusedBytesRatio.push(bytes === 0 ? 0 : reused / bytes);
      }
      this.#lastSuspended.set(hydrated.workflowId, { bytes, canons: shareableCanonSet(canons) });
    } else if (hydrated.status === "completed" || hydrated.status === "failed") {
      this.#lastSuspended.delete(hydrated.workflowId);
    }

    for (const simulation of this.#blobSimulations) simulation.observe(parsed, bytes);
  }

  report(): DurableInstrumentationReport {
    const byStatus: DurableInstrumentationReport["records"]["byStatus"] = {};
    for (const [status, stat] of this.#bytesByStatus) {
      const summary = stat.summary();
      byStatus[status] = { count: summary.count, bytes: summary };
    }
    return {
      blobRefBytes: BLOB_REF_BYTES,
      records: {
        count: this.#bytes.summary().count,
        bytes: this.#bytes.summary(),
        nodes: this.#nodes.summary(),
        depth: this.#depth.summary(),
        byStatus,
      },
      duplication: {
        duplicateSubtreeInstances: this.#duplicateInstances,
        duplicateSubtreeBytes: this.#duplicateBytes,
        dedupedBytes: this.#dedupedBytes.summary(),
        duplicationRatio: this.#duplicationRatio.summary(),
        continuation: {
          count: this.#continuationBytes.summary().count,
          bytes: this.#continuationBytes.summary(),
          shareOfRecordBytes: this.#continuationShare.summary(),
          duplicationRatio: this.#continuationDuplicationRatio.summary(),
        },
      },
      betweenSuspensions: {
        count: this.#nextSuspendedBytes.summary().count,
        previousBytes: this.#previousSuspendedBytes.summary(),
        nextBytes: this.#nextSuspendedBytes.summary(),
        grownBytes: this.#grownBytes.summary(),
        reusedBytesRatio: this.#reusedBytesRatio.summary(),
      },
      hydration: {
        count: this.#hydrationMs.summary().count,
        durationMs: this.#hydrationMs.summary(),
        approximateHeapDeltaBytes: this.#hydrationHeapDelta.summary(),
        peakRssBytes: this.#peakRssBytes,
      },
      blobbing: this.#blobSimulations.map((simulation) => simulation.estimate()),
    };
  }
}

function pendingResumeOf(record: WorkflowRecord): JSONType | undefined {
  if (record.status === "suspended") return record.pending.resume;
  if (record.status === "running" && record.basis.kind === "resume") {
    return record.basis.pending.resume;
  }
  return undefined;
}
