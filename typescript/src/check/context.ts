// The type-system counterpart to the runtime's `EvaluationContext`: one bag of
// state threaded through the walk. Unlike the evaluator, the checker
// *accumulates* diagnostics (recover-and-continue, assigning `any` on error)
// rather than failing fast, and it is structured for bidirectional checking
// (a `synth` mode and a `check`-against-expected mode).

import type { CallableEntry, CallableTypeRuleRegistry } from "./builtin-types";
import type { JSONType } from "../types";
import type { EffectManifest } from "../environment/effect-types";
import { type Schema, type Defs, type FnTypeShape, isSchemaObject } from "../schema/schema.ts";

// The tier of a diagnostic. An `error` is a definite type failure; an `info`
// makes a permissive fallback visible (a `→ any` degradation) without claiming
// the program is wrong. There is deliberately no `warning` tier (§4.5): the
// former runtime-checkable downgrade was anti-false-positive-fatigue design for
// human authors, but an agent reads a warning as an ambiguous signal. A
// mismatch the checker can't prove safe is now a hard `error` — prove it with a
// recognized guard, or discharge it with the `x!` assertion and eat a
// runtime-checked boundary.
type Severity = "error" | "info";

// A single type diagnostic, with a JSON-ish path to its location (§6).
type Diagnostic = {
  path: string[];
  message: string;
  severity: Severity;
  expected?: Schema;
  actual?: Schema;
};

// The term scope Γ: term name → type. A flat lookup with a parent chain,
// mirroring the evaluator's `getVar`. The optional `narrowings` argument carries
// the forcing site's flow facts into lazy-local resolution (§5.5 M2): a local
// that *references* a narrowed var is re-synthesized under those facts. Callers
// that never narrow (a function's `$fnType` never does) simply omit it and stay
// on the fast path.
type TypeEnv = {
  lookupType: (name: string, narrowings?: Record<string, Schema>) => Schema | undefined;
};

type CheckContext = {
  // The module `$types` pool ($defs), resolving `$ref`. The type-NAME scope.
  defs: Defs;
  // The term scope (Γ) — mirrors the evaluator's lexical `getVar` frames.
  env: TypeEnv;
  // Accumulate; never throw.
  diagnostics: Diagnostic[];
  // Current location, for messages.
  path: string[];
  // The polymorphic builtin layer (§5.3), loaded from `spec/builtins.json`.
  // Absent → a literal name not found in the lexical scope is unknown.
  callables?: Record<string, CallableEntry>;
  // The builtin dispatcher (Section F), injected at the entry points so the
  // core term checker never imports the builtin engine — that would close a
  // cycle (`synth` → dispatch → `synth`). Absent with a registry present leaves
  // that known callable on the imprecise dynamic-callee fallback.
  synthCallableCall?: (
    name: string,
    entry: CallableEntry,
    argExprs: JSONType[],
    ctx: CheckContext,
  ) => Schema;
  // Optional host-language implementations for namespaced callable rules.
  // Entry points install the core registry by default; an explicitly supplied
  // registry is used as-is so hosts can test fallback-only behavior.
  typeRules?: CallableTypeRuleRegistry;
  // Operator-owned effect contracts used by `core.perform`.
  effects?: EffectManifest;
  // Migration escape hatch for named function declarations without `$sig`.
  // Inline lambdas are governed by contextual typing instead.
  allowUntypedNamedFunctions?: boolean;
  // Flow-narrowing facts in scope (§5.5): var name → the type it has been
  // refined to by a dominating guard, already intersected with its declared
  // type. Present only inside a guarded control-flow arm; `synth`'s `"var"`
  // case consults it before the term scope. Absent ⇒ no narrowing active.
  narrowings?: Record<string, Schema>;
  // Lazy-local binding expressions in scope (§5.5 M2, §2.3): local name → its
  // un-annotated binding expression. Lets `factsFromCondition` recurse through a
  // named boolean guard (`empty: isNull(target)`) used as a bare-var condition.
  guards?: Record<string, JSONType>;
};

// A function signature — the shape shared by a body's `$sig` and the inner of
// a `$fnType` node (§2.8, §3.1). Reuses `FnTypeShape`.
type Sig = FnTypeShape;

const EMPTY_ENV: TypeEnv = { lookupType: () => undefined };

// Diagnostics helper: push a diagnostic at the current path. Severity defaults
// to `error`; callers override it for runtime-checkable warnings and visible
// permissive fallbacks.
function report(ctx: CheckContext, message: string, extra?: Partial<Diagnostic>): void {
  ctx.diagnostics.push({ path: [...ctx.path], message, severity: "error", ...extra });
}

// Record a checker fallback to `any` without turning it into a type error. Keep
// the prefix stable so CLI output and agent harnesses can identify degradation
// reasons consistently.
function reportDegradation(ctx: CheckContext, reason: string): void {
  report(ctx, `expression degraded to \`any\` because ${reason}.`, { severity: "info" });
}

// Not every loss of coverage produces `any`: a missing type rule can leave a
// concrete portable fallback active. Keep that distinction truthful while
// retaining the same info severity consumed by `--require-full-coverage`.
function reportCoverageDegradation(ctx: CheckContext, reason: string): void {
  report(ctx, `type coverage degraded because ${reason}.`, { severity: "info" });
}

// A deterministic JSON stringify (object keys sorted), for content-addressing
// schemas: the M2 fact-keyed re-synth cache keys on it and the end-of-module
// diagnostic dedupe compares by it. Key order can differ between two structurally
// equal schemas, so `JSON.stringify` alone is not safe here.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// A child context at a nested path segment (used when descending into args,
// branches, elements, ...). Cheap object spread — same "thread the bag"
// discipline as the evaluator's context.
function at(ctx: CheckContext, segment: string): CheckContext {
  return { ...ctx, path: [...ctx.path, segment] };
}

function isBody(v: JSONType): v is Record<string, JSONType> {
  return isSchemaObject(v) && "$return" in v;
}

// The declared signature of a function body, or null when unannotated.
function sigOf(body: Record<string, JSONType>): Sig | null {
  const sig = body.$sig;
  if (!isSchemaObject(sig)) return null;
  return {
    required: Array.isArray(sig.required) ? (sig.required as Schema[]) : [],
    optional: Array.isArray(sig.optional) ? (sig.optional as Schema[]) : [],
    rest: "rest" in sig ? sig.rest : undefined,
    returns: "returns" in sig ? sig.returns! : true,
  };
}

// The *type* of a function body as a value: its `$fnType` node, or `any` when
// the body carries no `$sig` (unannotated — inferring it needs the contextual
// typing deferred to a later milestone).
function bodyFnTypeSchema(body: Record<string, JSONType>): Schema {
  const sig = body.$sig;
  return isSchemaObject(sig) ? { $fnType: sig } : true;
}

export type { CheckContext, TypeEnv, Diagnostic, Severity, Sig };
export {
  EMPTY_ENV,
  report,
  reportDegradation,
  reportCoverageDegradation,
  at,
  isBody,
  sigOf,
  bodyFnTypeSchema,
  stableStringify,
};
