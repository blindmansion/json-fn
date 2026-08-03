import { RuntimeContractError } from "../../runtime-contract";
import { getOwnProperty } from "../../own-properties";
import { ExternalFunctionError } from "../../eval";
import type { JSONType } from "../../types";
import type { PreparedDurableDeployment } from "../deployment";
import { UnhandledEffectError } from "../run-task";
import { TaskRaiseError } from "../task-runtime";
import { WorkflowRevisionConflictError, type WorkflowStore } from "./store";
import type { PendingEffect, WorkflowFailure, WorkflowRecord } from "./workflow-record";

export type AdvanceOutcome =
  | { status: "completed"; result: JSONType }
  | { status: "failed"; failure: WorkflowFailure }
  | {
      status: "suspended";
      pending: { effectId: string; name: string; args: JSONType[] };
    };

export type DeliveryOutcome = AdvanceOutcome | { status: "stale" };

export type DurableDriver = {
  start(workflowId: string, args: JSONType[]): Promise<AdvanceOutcome>;
  deliverCompletion(
    workflowId: string,
    effectId: string,
    result: JSONType,
  ): Promise<DeliveryOutcome>;
  deliverFailure(
    workflowId: string,
    effectId: string,
    failure: { message: string; payload?: JSONType },
  ): Promise<DeliveryOutcome>;
  recover(workflowId: string): Promise<AdvanceOutcome>;
  read(workflowId: string): Promise<WorkflowRecord | undefined>;
};

export class DeploymentMismatchError extends Error {
  constructor(
    readonly workflowId: string,
    readonly recordDeploymentId: string,
    readonly configuredDeploymentId: string,
  ) {
    super(
      `workflow "${workflowId}" belongs to deployment "${recordDeploymentId}", not "${configuredDeploymentId}"`,
    );
    this.name = "DeploymentMismatchError";
  }
}

export function createDurableDriver(options: {
  deployment: PreparedDurableDeployment;
  store: WorkflowStore;
}): DurableDriver {
  const { deployment, store } = options;

  const assertDeployment = (record: WorkflowRecord): void => {
    if (record.deploymentId !== deployment.profile.deploymentId) {
      throw new DeploymentMismatchError(
        record.workflowId,
        record.deploymentId,
        deployment.profile.deploymentId,
      );
    }
  };

  const currentOutcome = async (workflowId: string): Promise<AdvanceOutcome> => {
    const current = await store.read(workflowId);
    if (current === undefined) throw new Error(`workflow "${workflowId}" does not exist`);
    assertDeployment(current);
    return current.status === "running" ? advance(current) : outcomeOf(current);
  };

  const transition = async (
    current: Extract<WorkflowRecord, { status: "running" }>,
    next: Exclude<WorkflowRecord, { status: "running" }>,
  ): Promise<AdvanceOutcome> => {
    try {
      await store.transition(current.revision, next);
      return outcomeOf(next);
    } catch (error) {
      if (!(error instanceof WorkflowRevisionConflictError)) throw error;
      return currentOutcome(current.workflowId);
    }
  };

  const fail = (
    current: Extract<WorkflowRecord, { status: "running" }>,
    failure: WorkflowFailure,
    effectSequence: number,
    invocationFuel: number,
  ): Promise<AdvanceOutcome> =>
    transition(current, {
      ...metadataAfter(current, effectSequence, invocationFuel),
      status: "failed",
      failure,
    });

  async function advance(
    current: Extract<WorkflowRecord, { status: "running" }>,
  ): Promise<AdvanceOutcome> {
    assertDeployment(current);
    const usage = { fuel: 0 };
    const runtime = deployment.createTaskSession({ usage });
    let sequence = current.effectSequence;
    let task: JSONType;

    try {
      task =
        current.basis.kind === "start"
          ? runtime.invokeEntry(runtime.validateArgs(current.basis.args))
          : runtime.applyResume(
              current.basis.pending.resume,
              current.basis.pending.name,
              current.basis.result,
            );

      for (;;) {
        const stepped = runtime.step(task);
        if ("done" in stepped) {
          const result = runtime.validateCompletion(stepped.done);
          return transition(current, {
            ...metadataAfter(current, sequence, runtime.fuelUsed()),
            status: "completed",
            result,
          });
        }

        const { name, args, resume } = stepped.pending;
        const effectId = `${current.workflowId}:${sequence}`;
        sequence += 1;

        const classification = getOwnProperty(deployment.profile.effects, name);
        if (classification === undefined) throw new UnhandledEffectError(name);
        if (classification === "suspending") {
          const pending: PendingEffect = { effectId, name, args, resume };
          return transition(current, {
            ...metadataAfter(current, sequence, runtime.fuelUsed()),
            status: "suspended",
            pending,
          });
        }

        const capability = getOwnProperty(deployment.effects, name)!;
        let result: JSONType;
        try {
          runtime.refreshDeadline();
          result = await capability({ workflowId: current.workflowId, effectId }, ...args);
        } catch (error) {
          return fail(
            current,
            { code: "host", message: errorMessage(error) },
            sequence,
            runtime.fuelUsed(),
          );
        }
        task = runtime.applyResume(resume, name, result);
      }
    } catch (error) {
      return fail(current, mapExecutionFailure(error), sequence, runtime.fuelUsed());
    }
  }

  return {
    async start(workflowId, args) {
      // Validate before creation so an invalid request does not reserve an ID.
      const runtime = deployment.createTaskSession({ usage: { fuel: 0 } });
      const checkedArgs = runtime.validateArgs(args);
      const record: Extract<WorkflowRecord, { status: "running" }> = {
        workflowId,
        revision: 0,
        deploymentId: deployment.profile.deploymentId,
        effectSequence: 0,
        fuelUsed: 0,
        status: "running",
        basis: { kind: "start", args: checkedArgs },
      };
      await store.create(record);
      return advance(record);
    },

    async deliverCompletion(workflowId, effectId, result) {
      const existing = await store.read(workflowId);
      if (existing !== undefined) assertDeployment(existing);
      const claim = await store.claim(workflowId, effectId, result);
      return "stale" in claim ? { status: "stale" } : advanceRunning(claim.claimed);
    },

    async deliverFailure(workflowId, effectId, delivered) {
      const existing = await store.read(workflowId);
      if (existing !== undefined) assertDeployment(existing);
      const claim = await store.claim(workflowId, effectId, null);
      if ("stale" in claim) return { status: "stale" };
      const running = requireRunning(claim.claimed);
      return transition(running, {
        ...metadataAfter(running, running.effectSequence, 0),
        status: "failed",
        failure: {
          code: "external",
          message: delivered.message,
          ...(delivered.payload === undefined ? {} : { payload: delivered.payload }),
        },
      });
    },

    async recover(workflowId) {
      const record = await store.read(workflowId);
      if (record === undefined) throw new Error(`workflow "${workflowId}" does not exist`);
      assertDeployment(record);
      return record.status === "running" ? advance(record) : outcomeOf(record);
    },

    read: (workflowId) => store.read(workflowId),
  };

  function advanceRunning(record: WorkflowRecord): Promise<AdvanceOutcome> {
    return advance(requireRunning(record));
  }
}

function requireRunning(record: WorkflowRecord): Extract<WorkflowRecord, { status: "running" }> {
  if (record.status !== "running") throw new Error("store claim did not return a running record");
  return record;
}

function metadataAfter(
  record: WorkflowRecord,
  effectSequence: number,
  invocationFuel: number,
): Pick<
  WorkflowRecord,
  "workflowId" | "revision" | "deploymentId" | "effectSequence" | "fuelUsed"
> {
  return {
    workflowId: record.workflowId,
    revision: record.revision + 1,
    deploymentId: record.deploymentId,
    effectSequence,
    fuelUsed: record.fuelUsed + invocationFuel,
  };
}

function outcomeOf(record: Exclude<WorkflowRecord, { status: "running" }>): AdvanceOutcome {
  switch (record.status) {
    case "completed":
      return { status: "completed", result: record.result };
    case "failed":
      return { status: "failed", failure: record.failure };
    case "suspended":
      return {
        status: "suspended",
        pending: {
          effectId: record.pending.effectId,
          name: record.pending.name,
          args: record.pending.args,
        },
      };
  }
}

function mapExecutionFailure(error: unknown): WorkflowFailure {
  if (error instanceof ExternalFunctionError && error.functionName.startsWith("@adapter:")) {
    return { code: "host", message: error.message };
  }
  if (error instanceof TaskRaiseError) {
    return { code: "raise", message: error.message, payload: error.payload };
  }
  if (error instanceof UnhandledEffectError) {
    return { code: "unknown-effect", message: error.message };
  }
  if (error instanceof RuntimeContractError) {
    return {
      code: error.message.startsWith('unknown effect "') ? "unknown-effect" : "contract",
      message: error.message,
    };
  }
  const message = errorMessage(error);
  if (
    message === "Execution aborted" ||
    message === "Execution timed out" ||
    message.startsWith("Maximum fuel limit") ||
    message.startsWith("Maximum value size") ||
    message.startsWith("Maximum call depth") ||
    message.startsWith("Maximum structural depth") ||
    message.startsWith("Maximum evaluation nesting")
  ) {
    return { code: "limit", message };
  }
  return { code: "malformed-task", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
