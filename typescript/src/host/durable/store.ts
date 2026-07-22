import type { JSONType } from "../../types";
import {
  hydrateWorkflowRecord,
  serializeWorkflowRecord,
  type WorkflowRecord,
} from "./workflow-record";

export type ClaimOutcome = { claimed: WorkflowRecord } | { stale: true };

export interface WorkflowStore {
  create(record: WorkflowRecord): Promise<void>;
  transition(expectedRevision: number, record: WorkflowRecord): Promise<void>;
  claim(workflowId: string, effectId: string, result: JSONType): Promise<ClaimOutcome>;
  read(workflowId: string): Promise<WorkflowRecord | undefined>;
  listNonterminal(): Promise<string[]>;
}

export class WorkflowAlreadyExistsError extends Error {
  constructor(readonly workflowId: string) {
    super(`workflow "${workflowId}" already exists`);
    this.name = "WorkflowAlreadyExistsError";
  }
}

export class WorkflowRevisionConflictError extends Error {
  constructor(
    readonly workflowId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number | undefined,
  ) {
    super(
      actualRevision === undefined
        ? `workflow "${workflowId}" does not exist`
        : `workflow "${workflowId}" revision conflict: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "WorkflowRevisionConflictError";
  }
}

/**
 * Reference store for tests and examples. Records are held as serialized text
 * so every boundary exercises validation and inertness restoration.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  readonly #records = new Map<string, string>();

  async create(record: WorkflowRecord): Promise<void> {
    const serialized = serializeWorkflowRecord(record);
    if (this.#records.has(record.workflowId)) {
      throw new WorkflowAlreadyExistsError(record.workflowId);
    }
    this.#records.set(record.workflowId, serialized);
  }

  async transition(expectedRevision: number, record: WorkflowRecord): Promise<void> {
    const serialized = serializeWorkflowRecord(record);
    const current = this.#readStored(record.workflowId);
    if (current?.revision !== expectedRevision) {
      throw new WorkflowRevisionConflictError(
        record.workflowId,
        expectedRevision,
        current?.revision,
      );
    }
    this.#records.set(record.workflowId, serialized);
  }

  async claim(workflowId: string, effectId: string, result: JSONType): Promise<ClaimOutcome> {
    const current = this.#readStored(workflowId);
    if (
      current === undefined ||
      current.status !== "suspended" ||
      current.pending.effectId !== effectId
    ) {
      return { stale: true };
    }

    const claimed: WorkflowRecord = {
      workflowId: current.workflowId,
      revision: current.revision + 1,
      deploymentId: current.deploymentId,
      effectSequence: current.effectSequence,
      fuelUsed: current.fuelUsed,
      status: "running",
      basis: { kind: "resume", pending: current.pending, result },
    };
    const serialized = serializeWorkflowRecord(claimed);
    this.#records.set(workflowId, serialized);
    return { claimed: hydrateWorkflowRecord(serialized) };
  }

  async read(workflowId: string): Promise<WorkflowRecord | undefined> {
    return this.#readStored(workflowId);
  }

  async listNonterminal(): Promise<string[]> {
    const workflowIds: string[] = [];
    for (const [workflowId, serialized] of this.#records) {
      const record = hydrateWorkflowRecord(serialized);
      if (record.status === "running" || record.status === "suspended") {
        workflowIds.push(workflowId);
      }
    }
    return workflowIds;
  }

  #readStored(workflowId: string): WorkflowRecord | undefined {
    const serialized = this.#records.get(workflowId);
    return serialized === undefined ? undefined : hydrateWorkflowRecord(serialized);
  }
}
