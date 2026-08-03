/**
 * Tasks & effects — the semantic kernel described in `plans/effects-implementation.md`.
 *
 * A task is an inert, tagged plain record built only by the constructors
 * (`perform`/`pure`/`bind`/`raise`) and marked as a runtime value so the
 * evaluator never re-walks it. The kernel is deliberately tiny: three node kinds plus one
 * `handle` builtin plus (Phase 4) a host trampoline. Everything richer — retry,
 * state, error handling, dry-runs — is guest library code, which works because
 * escaping-closure capture makes continuations self-contained JSON.
 *
 * The tag key is `"@task"` (not a `$`-key) so a rehydrated node classifies as a
 * plain Object in `evaluate.ts` and the shorthand data-object rule forbidding
 * `$`-keys is untouched. Users *can* forge one, which is harmless: enforcement
 * is host-side (a forged effect name has no interpreter), and forged *malformed*
 * nodes fail here as clean guest-visible evaluator errors, never TS exceptions.
 */

import type { JSONType, Meter } from "./types";
import type { Defs, Schema } from "./schema/schema.ts";
import { enforceRuntimeContract, RuntimeContractError } from "./runtime-contract";
import { getOwnProperty } from "./own-properties";
import { requireParameterLayout } from "./params";
import { markRuntimeValue } from "./runtime-values";
import { isFunctionDeclaration } from "./function-value";

/** The reserved tag key marking a value as a task node. */
export const TASK_TAG = "@task";

export type EffectTask = { "@task": "effect"; name: string; args: JSONType[] };
export type PureTask = { "@task": "pure"; value: JSONType };
export type BindTask = { "@task": "bind"; task: JSONType; then: JSONType };
export type TaskNode = EffectTask | PureTask | BindTask;

/**
 * The public suspended form (`plans/effects-implementation.md` §1): the stable
 * contract shared by `handle`, the host trampoline, and durable storage. Any
 * task normalizes (via `stepTask`) to exactly one of these two shapes.
 *
 * `resume` is an ordinary self-contained closure (plain JSON), so a `pending`
 * record can be persisted, shipped, printed, or answered — possibly more than
 * once (multi-shot).
 */
export type Suspended =
  | { done: JSONType }
  | { pending: { name: string; args: JSONType[]; resume: JSONType } };

/** Structural guard: a plain (non-array) object whose `@task` tag is a string. */
export function isTask(value: unknown): value is TaskNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[TASK_TAG] === "string"
  );
}

function isPlainObject(value: JSONType): value is Record<string, JSONType> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ----- constructors (shared by the stdlib builtins) -----

export function effectTask(name: string, args: JSONType[]): JSONType {
  return markRuntimeValue({ [TASK_TAG]: "effect", name, args });
}

export function pureTask(value: JSONType): JSONType {
  return markRuntimeValue({ [TASK_TAG]: "pure", value });
}

export function bindTask(task: JSONType, then: JSONType): JSONType {
  // eslint-disable-next-line no-thenable -- `then` is the spec'd task field name, not a Promise
  return markRuntimeValue({ [TASK_TAG]: "bind", task, then });
}

// The parameter name of every constructed `resume`/handler-wrapping closure.
// It only ever binds in the tiny generated closure below; the continuation
// bodies it wraps are `$raw` (inert), so there is no capture interaction.
const RESUME_PARAM = "__v";

/**
 * Build the plain-JSON continuation closure `(v) => <task>` for a suspended
 * effect, by folding the pending continuation stack `ks` over `pure(v)`:
 *
 *   resume(v) = bind(bind(pure(v), k_first), ..., k_last)
 *
 * `ks` is ordered outermost-last (as pushed while walking the `bind` spine), so
 * we wrap from the top of the stack (the continuation nearest the effect)
 * outward. Each continuation is embedded via `$raw` so it stays inert. The
 * result is marked as a runtime value: it is self-contained, so `replaceVars`
 * must never descend into it during escaping-closure capture.
 */
function buildStepResume(ks: JSONType[]): JSONType {
  let expr: JSONType = { $call: "pure", $args: [{ $var: RESUME_PARAM }] };
  for (let i = ks.length - 1; i >= 0; i--) {
    expr = { $call: "bind", $args: [expr, { $raw: ks[i]! }] };
  }
  return markRuntimeValue({ $params: [RESUME_PARAM], $return: expr });
}

/**
 * Wrap a step-level `resume` so re-entry is re-interpreted by the same handler:
 *
 *   handleResume(v) = handle(stepResume(v), handlers)
 *
 * This is what a handler clause receives as `resume`, and also the continuation
 * of a bubbled effect. Multi-shot is free: each call rebuilds the task from
 * inert JSON and re-runs `handle`.
 */
function handleArgs(
  task: JSONType,
  handlers: JSONType,
  annotation: Schema | undefined,
): JSONType[] {
  const args: JSONType[] = [task, { $raw: handlers }];
  if (annotation !== undefined) args.push({ $raw: annotation });
  return args;
}

function wrapResume(
  stepResume: JSONType,
  handlers: JSONType,
  annotation: Schema | undefined,
): JSONType {
  return markRuntimeValue({
    $params: [RESUME_PARAM],
    $return: {
      $call: "handle",
      $args: handleArgs(
        { $call: { $raw: stepResume }, $args: [{ $var: RESUME_PARAM }] },
        handlers,
        annotation,
      ),
    },
  });
}

/**
 * Normalize a task to the public suspended form. Walks the `bind` spine
 * iteratively: `bind` pushes its continuation and descends into the inner task;
 * `pure` pops and applies the next continuation (through `call`, so fuel/depth
 * are metered); an `effect` suspends, reifying the remaining continuations into
 * a plain-JSON `resume`. Malformed nodes raise clean guest-visible errors.
 */
export function stepTask(
  task: JSONType,
  call: (fn: JSONType, args: JSONType[]) => JSONType,
  meter: Meter,
): Suspended {
  const ks: JSONType[] = [];
  let current = task;
  for (;;) {
    meter.charge(1);
    if (!isTask(current)) {
      throw new Error(`Task expected, got ${JSON.stringify(current)}`);
    }
    const tag = (current as Record<string, JSONType>)[TASK_TAG] as string;
    if (tag === "bind") {
      const then = (current as unknown as BindTask).then;
      if (!isFunctionDeclaration(then)) {
        throw new Error("Malformed task: bind `then` must be a function");
      }
      ks.push(then);
      current = (current as unknown as BindTask).task;
      continue;
    }
    if (tag === "pure") {
      const value = (current as unknown as PureTask).value;
      if (ks.length === 0) return { done: value };
      const continuation = ks.pop()!;
      // `do` discards deliberately lower to a zero-parameter continuation,
      // unlike `_ <- task`, whose one parameter receives the completed value.
      const discards =
        typeof continuation !== "string" &&
        requireParameterLayout((continuation as Record<string, JSONType>).$params, continuation)
          .slots.length === 0;
      current = call(continuation, discards ? [] : [value]);
      continue;
    }
    if (tag === "effect") {
      const { name, args } = current as unknown as EffectTask;
      if (typeof name !== "string") {
        throw new Error("Malformed task: effect `name` must be a string");
      }
      if (!Array.isArray(args)) {
        throw new Error("Malformed task: effect `args` must be an array");
      }
      return { pending: { name, args, resume: buildStepResume(ks) } };
    }
    throw new Error(`Malformed task: unknown @task tag ${JSON.stringify(tag)}`);
  }
}

/**
 * The `then` continuation of a bubbled effect. Unlike a clause's `resume`
 * (which yields the fully-handled *value*), this is a `bind` continuation, so
 * it must yield a *task*: it re-handles the rest under the same handlers, then
 * lifts a fully-handled value back into `pure` (a still-bubbling residual is
 * already a task and passes through). Without the lift, a nested handler that
 * finishes interpreting a bubbled continuation would hand a bare value to the
 * enclosing `stepTask`, which expects a task.
 */
function bubbleContinuation(stepResume: JSONType, handlers: JSONType): JSONType {
  return markRuntimeValue({
    $params: [RESUME_PARAM],
    $return: {
      $let: {
        __r: {
          $call: "handle",
          $args: [
            { $call: { $raw: stepResume }, $args: [{ $var: RESUME_PARAM }] },
            { $raw: handlers },
          ],
        },
      },
      $in: {
        $if: { $call: "isTask", $args: [{ $var: "__r" }] },
        $then: { $var: "__r" },
        $else: { $call: "pure", $args: [{ $var: "__r" }] },
      },
    },
  });
}

/** A bubbled effect: re-perform the unmatched effect, re-handling the rest. */
function bubble(
  name: string,
  args: JSONType[],
  stepResume: JSONType,
  handlers: JSONType,
): JSONType {
  return bindTask(effectTask(name, args), bubbleContinuation(stepResume, handlers));
}

/**
 * The `handle` builtin. Normalize the task once; then either lift the completion
 * value (through a `"return"` clause if present) or dispatch the first effect to
 * a matching clause. Named clauses get the effect args spread plus `resume` last;
 * a reserved `"*"` wildcard clause gets `({ name, args }, resume)`. An unmatched
 * effect bubbles outward in the partial form and is a contract error in the
 * annotated form.
 */
export function runHandle(
  task: JSONType,
  handlers: JSONType,
  call: (fn: JSONType, args: JSONType[]) => JSONType,
  meter: Meter,
  annotation?: Schema,
  defs: Defs = {},
): JSONType {
  if (!isPlainObject(handlers)) {
    throw new Error("handle: second argument must be a record of handler clauses");
  }

  const finish = (value: JSONType): JSONType =>
    annotation === undefined
      ? value
      : enforceRuntimeContract(value, annotation, defs, "handle result");

  const s = stepTask(task, call, meter);
  if ("done" in s) {
    const ret = handlers["return"];
    if (ret !== undefined && isFunctionDeclaration(ret)) return finish(call(ret, [s.done]));
    return finish(s.done);
  }

  const { name, args, resume } = s.pending;
  const handleResume = wrapResume(resume, handlers, annotation);

  const named = getOwnProperty(handlers as Record<string, JSONType>, name);
  if (named !== undefined && isFunctionDeclaration(named)) {
    return finish(call(named, [...args, handleResume]));
  }

  const wild = handlers["*"];
  if (wild !== undefined && isFunctionDeclaration(wild)) {
    return finish(call(wild, [{ name, args }, handleResume]));
  }

  if (annotation !== undefined) {
    throw new RuntimeContractError(
      `handle result contract failed: unmatched effect ${JSON.stringify(name)}`,
    );
  }
  return bubble(name, args, resume, handlers);
}
