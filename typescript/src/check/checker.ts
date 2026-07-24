// Two scopes, as in the design (§D of the plan):
//   * Type-name scope: `resolveRef` over `ctx.defs` (flat; recursion guard
//     lives in `subsumes`).
//   * Term scope (Γ): lexical environments mirroring the evaluator's frames.
//
// Params bind eagerly from the declared `$sig`. Function-valued `$let` and
// module bindings bind eagerly to their `$fnType`. Other `$let`/module bindings
// are typed *lazily* at their first lookup — reusing the shape of `getVar`'s
// `resolvingVars` cycle guard.

import type { JSONType } from "../types";
import {
  analyzeFunctionBodyStructure,
  formatFunctionBodyStructureIssue,
  type FunctionBodyStructureAnalysis,
} from "../function-body-structure";
import {
  boundParameterNames,
  defaultBindings,
  formatArgumentCountExpectation,
  type ParameterLayout,
  type ParameterPath,
} from "../params";
import { asPath, litOf, nodeKind } from "./ast";
import {
  at,
  bodyFnTypeSchema,
  isBody,
  report,
  reportDegradation,
  sigOf,
  stableStringify,
  type CheckContext,
  type Sig,
  type TypeEnv,
} from "./context";
import {
  withNarrowings,
  factsFromCondition,
  removeType,
  restrictToTruthy,
  restrictToFalsy,
  caseUniverse,
  matchCaseFact,
  matchElseFact,
} from "./narrowing";
import {
  apMode,
  asObject,
  classifySchema,
  collectSchemaRefs,
  deepEqual,
  fixedParamSchemas,
  fnShape,
  isClosedMissingKey,
  itemsSchema,
  prefixItems,
  projectComputed,
  projectField,
  properties,
  requiredKeys,
  resolveDeep,
  SchemaKind,
  tupleRest,
  unionOf,
  widenLiteral,
  type Schema,
} from "../schema/schema.ts";
import { isRuntimeContractSchema } from "../schema/contract.ts";
import { isSubschema } from "./subsumption";

function issueContext(ctx: CheckContext, path: readonly (string | number)[]): CheckContext {
  const segments: string[] = [];
  for (const segment of path) {
    if (typeof segment === "number") {
      segments[segments.length - 1] += `[${segment}]`;
    } else {
      segments.push(segment);
    }
  }
  return { ...ctx, path: [...ctx.path, ...segments] };
}

// Adapt a structured parameter issue to the checker's existing path format.
function parameterIssueContext(ctx: CheckContext, path: ParameterPath): CheckContext {
  return issueContext(ctx, ["$params", ...path]);
}

function analyzeCheckerFunctionBody(
  body: Record<string, JSONType>,
  ctx: CheckContext,
): FunctionBodyStructureAnalysis {
  const analysis = analyzeFunctionBodyStructure(body);
  for (const issue of analysis.issues) {
    const message = formatFunctionBodyStructureIssue(issue);
    report(issueContext(ctx, issue.path), message[0]!.toLowerCase() + message.slice(1));
  }
  return analysis;
}

// Callable declarations and normalized bodies must agree on each part of their
// shape. Equal fixed counts are not enough: one required plus one optional
// parameter admits different calls from two required parameters.
function parameterShapeMatches(layout: ParameterLayout, sig: Sig): boolean {
  return (
    layout.requiredCount === sig.required.length &&
    layout.omittableCount === sig.optional.length &&
    (layout.rest !== null) === (sig.rest !== undefined)
  );
}

function describeParameterLayout(layout: ParameterLayout): string {
  return `${layout.requiredCount} required parameter(s), ${layout.omittableCount} optional parameter(s), and ${
    layout.rest === null ? "no rest parameter" : "a rest parameter"
  }`;
}

function describeSigShape(sig: Sig): string {
  return `${sig.required.length} required parameter(s), ${sig.optional.length} optional parameter(s), and ${
    sig.rest === undefined ? "no rest parameter" : "a rest parameter"
  }`;
}

function acceptsArgumentCount(sig: Sig, argc: number): boolean {
  const minimum = sig.required.length;
  const maximum = fixedParamSchemas(sig).length;
  return argc >= minimum && (sig.rest !== undefined || argc <= maximum);
}

type TypedDefault = {
  expression: JSONType;
  expected: Schema;
  path: ParameterPath;
};

type TypedParameterBindings = {
  eager: Record<string, Schema>;
  defaults: TypedDefault[];
  valid: boolean;
};

const NULL_SCHEMA: Schema = { type: "null" };

// Align normalized parameters with their supplied-value schemas once. The
// resulting local types and retained defaults share the same projection, so
// default checking cannot later disagree with parameter binding.
function bindParams(
  layout: ParameterLayout,
  sig: Sig | null,
  ctx: CheckContext,
): TypedParameterBindings {
  const eager = nullRecord<Schema>();
  const defaults: TypedDefault[] = [];
  let valid = true;
  const sigParams = sig === null ? [] : fixedParamSchemas(sig);
  const rest = sig?.rest;

  for (const slot of layout.slots) {
    if (slot.kind === "rest") {
      eager[slot.name] = { type: "array", items: rest ?? true };
      continue;
    }

    const supplied = sigParams[slot.index] ?? true;
    if (slot.kind !== "fields") {
      eager[slot.name] = slot.kind === "optional" ? unionOf([supplied, NULL_SCHEMA]) : supplied;
      if (slot.kind === "defaulted") {
        defaults.push({
          expression: slot.defaultExpression,
          expected: supplied,
          path: [slot.index, "$default"],
        });
      }
      continue;
    }

    // A body without a signature remains permissive, but its normalized field
    // kinds still determine nullability and which defaults need checking.
    if (sig === null) {
      for (const binding of slot.bindings) {
        eager[binding.name] = binding.kind === "optional" ? unionOf([true, NULL_SCHEMA]) : true;
        if (binding.kind === "defaulted") {
          defaults.push({
            expression: binding.defaultExpression,
            expected: true,
            path: [slot.index, "$fields", binding.fieldIndex, "$default"],
          });
        }
      }
      continue;
    }

    const resolved = resolveDeep(supplied, ctx.defs);
    if (resolved !== true && classifySchema(resolved) !== SchemaKind.Object) {
      report(
        parameterIssueContext(ctx, [slot.index]),
        "Object parameter pattern requires an object schema in the aligned signature slot.",
        { expected: { type: "object" }, actual: supplied },
      );
      valid = false;
      for (const binding of slot.bindings) eager[binding.name] = false;
      continue;
    }

    const obj = resolved === true ? null : asObject(resolved);
    const props = obj === null ? {} : properties(obj);
    const required = obj === null ? [] : requiredKeys(obj);
    const mode = obj === null ? { kind: "open" as const } : apMode(obj);

    for (const binding of slot.bindings) {
      const path: ParameterPath = [slot.index, "$fields", binding.fieldIndex];
      const fieldCtx = parameterIssueContext(ctx, path);
      const isNamed = binding.name in props;
      const fieldSchema = isNamed
        ? props[binding.name]!
        : mode.kind === "map"
          ? mode.schema
          : mode.kind === "open"
            ? true
            : null;

      if (fieldSchema === null) {
        report(
          fieldCtx,
          `Field "${binding.name}" is not permitted by the aligned closed object schema.`,
        );
        valid = false;
        eager[binding.name] = false;
        continue;
      }

      const guaranteed = required.includes(binding.name);
      if (binding.kind === "required" && !guaranteed) {
        report(
          fieldCtx,
          `Required field "${binding.name}" is not guaranteed by the aligned object schema.`,
        );
        valid = false;
        eager[binding.name] = false;
        continue;
      }
      if (binding.kind !== "required" && guaranteed) {
        report(
          fieldCtx,
          `${binding.kind === "defaulted" ? "Defaulted" : "Optional"} field "${binding.name}" is required by the aligned object schema and cannot be omitted.`,
        );
        valid = false;
        eager[binding.name] = false;
        continue;
      }

      eager[binding.name] =
        binding.kind === "optional" ? unionOf([fieldSchema, NULL_SCHEMA]) : fieldSchema;
      if (binding.kind === "defaulted") {
        defaults.push({
          expression: binding.defaultExpression,
          expected: fieldSchema,
          path: [slot.index, "$fields", binding.fieldIndex, "$default"],
        });
      }
    }
  }

  return { eager, defaults, valid };
}

// Defaults run in the completed body scope but retain the supplied-value type
// chosen during parameter binding. They neither narrow nor redefine the local.
function checkParameterDefaults(defaults: readonly TypedDefault[], ctx: CheckContext): void {
  for (const defaultBinding of defaults) {
    check(
      defaultBinding.expression,
      defaultBinding.expected,
      parameterIssueContext(ctx, defaultBinding.path),
    );
  }
}

function isLetBindingMap(value: JSONType | undefined): value is Record<string, JSONType> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateLet(
  value: Record<string, JSONType>,
  ctx: CheckContext,
): { bindings: Record<string, JSONType>; result: JSONType } | null {
  const hasLet = "$let" in value;
  const hasIn = "$in" in value;
  if (!(hasLet && hasIn)) {
    report(ctx, "$let expressions must have both $let and $in properties.");
    return null;
  }
  if (Object.keys(value).length !== 2) {
    report(ctx, "$let expressions cannot have other properties.");
    return null;
  }
  if (!isLetBindingMap(value.$let)) {
    report(at(ctx, "$let"), "$let must be a non-null object of bindings.");
    return null;
  }
  if (Object.keys(value.$let).length === 0) {
    report(at(ctx, "$let"), "$let must contain at least one binding.");
    return null;
  }
  return { bindings: value.$let, result: value.$in! };
}

function withoutShadowedNarrowings(ctx: CheckContext, names: readonly string[]): CheckContext {
  if (ctx.narrowings === undefined) return ctx;
  const shadowed = new Set(names);
  const narrowings = Object.fromEntries(
    Object.entries(ctx.narrowings).filter(([path]) => !shadowed.has(path.split(".", 1)[0]!)),
  );
  return { ...ctx, narrowings: Object.keys(narrowings).length === 0 ? undefined : narrowings };
}

// Collect every `$var` name syntactically referenced by an expression. Used to
// over-approximate a lazy local's free variables (§5.5 M2 §2.2b): we descend
// into everything except `$raw` payloads (unevaluated data), *including* nested
// lambda bodies — ignoring their shadowing is a sound over-approximation (a
// superset only ever triggers a harmless extra re-synth, never a stale type).
function collectVars(expr: JSONType, acc: Set<string>): void {
  collectFreeVars(expr, acc, new Set());
}

function collectFreeVars(expr: JSONType, acc: Set<string>, bound: ReadonlySet<string>): void {
  if (expr === null || typeof expr !== "object") return;
  if (Array.isArray(expr)) {
    for (const e of expr) collectFreeVars(e, acc, bound);
    return;
  }
  const o = expr as Record<string, JSONType>;
  if (typeof o.$var === "string") {
    if (!bound.has(o.$var)) acc.add(o.$var);
    return;
  }
  if ("$raw" in o) return;
  if (nodeKind(o) === "let") {
    const bindings = isLetBindingMap(o.$let) ? o.$let : {};
    const nestedBound = new Set([...bound, ...Object.keys(bindings)]);
    for (const value of Object.values(bindings)) collectFreeVars(value, acc, nestedBound);
    if ("$in" in o) collectFreeVars(o.$in!, acc, nestedBound);
    return;
  }
  // A static access path (`move.from`) is itself a narrowable subject (§5.5 M3),
  // so record it alongside its root var — a local that reaches through it must
  // re-synth when that path is narrowed. Then descend as usual (the root var is
  // still collected from `$from`).
  if (nodeKind(o) === "get") {
    const p = asPath(o);
    if (p !== null && !bound.has(p.split(".", 1)[0]!)) acc.add(p);
  }
  for (const val of Object.values(o)) collectFreeVars(val, acc, bound);
}

// Collect lexical term references for `$let` reachability. Unlike the
// narrowing-oriented collector above, named calls and function references are
// dependencies too. Nested lets, function parameters, and runtime captures
// mask outer names.
function collectReferencedNames(
  expr: JSONType,
  acc: Set<string>,
  bound: ReadonlySet<string> = new Set(),
): void {
  if (expr === null || typeof expr !== "object") return;
  if (Array.isArray(expr)) {
    for (const item of expr) collectReferencedNames(item, acc, bound);
    return;
  }

  const object = expr as Record<string, JSONType>;
  if ("$raw" in object) return;
  const kind = nodeKind(object);

  if (kind === "var") {
    const name = object.$var;
    if (typeof name === "string" && !bound.has(name)) acc.add(name);
    return;
  }
  if (kind === "ref") {
    const target = object.$fn;
    if (typeof target === "string") {
      if (!bound.has(target)) acc.add(target);
    } else if (target !== undefined) {
      collectReferencedNames(target, acc, bound);
    }
    return;
  }
  if (kind === "call") {
    const target = object.$call;
    if (typeof target === "string") {
      if (!bound.has(target)) acc.add(target);
    } else if (target !== undefined) {
      collectReferencedNames(target, acc, bound);
    }
    if (Array.isArray(object.$args)) {
      for (const arg of object.$args) collectReferencedNames(arg, acc, bound);
    }
    return;
  }
  if (kind === "let") {
    const bindings = isLetBindingMap(object.$let) ? object.$let : {};
    const nestedBound = new Set([...bound, ...Object.keys(bindings)]);
    for (const value of Object.values(bindings)) {
      collectReferencedNames(value, acc, nestedBound);
    }
    if ("$in" in object) collectReferencedNames(object.$in!, acc, nestedBound);
    return;
  }
  if (kind === "body") {
    const analysis = analyzeFunctionBodyStructure(object);
    const parameterNames = analysis.layout === null ? [] : boundParameterNames(analysis.layout);
    const bodyBound = new Set([...bound, ...Object.keys(analysis.captures), ...parameterNames]);
    if (analysis.layout !== null) {
      for (const binding of defaultBindings(analysis.layout)) {
        collectReferencedNames(binding.expression, acc, bodyBound);
      }
    }
    for (const capture of Object.values(analysis.captures)) {
      collectReferencedNames(capture, acc, bodyBound);
    }
    if ("$return" in object) collectReferencedNames(object.$return!, acc, bodyBound);
    return;
  }

  for (const value of Object.values(object)) collectReferencedNames(value, acc, bound);
}

function reachableLetBindingNames(
  bindings: Record<string, JSONType>,
  result: JSONType,
): Set<string> {
  const bindingNames = new Set(Object.keys(bindings));
  const reachable = new Set<string>();
  const pending = new Set<string>();
  collectReferencedNames(result, pending);

  while (pending.size > 0) {
    const name = pending.values().next().value!;
    pending.delete(name);
    if (!bindingNames.has(name) || reachable.has(name)) continue;
    reachable.add(name);

    const dependencies = new Set<string>();
    collectReferencedNames(bindings[name]!, dependencies);
    for (const dependency of dependencies) {
      if (!reachable.has(dependency)) pending.add(dependency);
    }
  }
  return reachable;
}

function reachableLetBindings(
  bindings: Record<string, JSONType>,
  result: JSONType,
  ctx: CheckContext,
): Record<string, JSONType> {
  const reachable = reachableLetBindingNames(bindings, result);
  const retained = nullRecord<JSONType>();
  for (const [name, value] of Object.entries(bindings)) {
    if (reachable.has(name)) {
      retained[name] = value;
    } else {
      report(at(at(ctx, "$let"), name), `unused local binding "${name}"`);
    }
  }
  return retained;
}

type TypeScopeResult = {
  env: TypeEnv;
  guards: Record<string, JSONType>;
};

type FunctionTypeScopeResult = TypeScopeResult & {
  parameterDefaults: TypedDefault[];
  parameterBindingsValid: boolean;
  narrowings: Record<string, Schema> | undefined;
};

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function buildLetrecTypeScope(
  bindings: Record<string, JSONType>,
  parent: TypeEnv | null,
  ctx: CheckContext,
  options: {
    reportUntypedFunctions: boolean;
    bindingPath: CheckContext;
    checkFunctionBodies: boolean;
  },
): TypeScopeResult {
  const exprLocals = nullRecord<JSONType>();
  const functionLocals = nullRecord<Record<string, JSONType>>();
  const eager = nullRecord<Schema>();

  for (const [key, val] of Object.entries(bindings)) {
    if (nodeKind(val) === "body" && isBody(val)) {
      functionLocals[key] = val;
      if (options.reportUntypedFunctions && sigOf(val) === null) {
        const bindingCtx = at(options.bindingPath, key);
        if (ctx.allowUntypedNamedFunctions === true) {
          reportDegradation(bindingCtx, `function binding "${key}" has no declared signature`);
        } else {
          report(
            bindingCtx,
            `function binding "${key}" must declare a signature (typed parameters and return)`,
          );
        }
      }
      eager[key] = bodyFnTypeSchema(val); // sibling function: eager `$fnType`
    } else {
      exprLocals[key] = val; // un-annotated local: typed lazily below
    }
  }

  // Lazy locals double as named boolean guards (§2.3); outer guards remain in
  // scope, with siblings shadowing them.
  const guards = Object.assign(nullRecord<JSONType>(), ctx.guards);
  for (const name of [...Object.keys(eager), ...Object.keys(bindings)]) delete guards[name];
  Object.assign(guards, exprLocals);
  // Facts that dominate creation of this lexical scope also dominate every
  // evaluation of its lazy locals. A forcing site can add facts, but crossing
  // an inline-function or callback boundary must not erase the facts under
  // which the scope itself was created.
  const creationNarrowings = ctx.narrowings ?? {};

  // Two-tier cache: `memo` is the type when no creation/forcing facts relevant
  // to the local are active; `narrowedMemo[name][key]` holds a re-synth under a
  // specific set of *relevant* merged facts (§2.2c).
  const memo = nullRecord<Schema>();
  const narrowedMemo = nullRecord<Record<string, Schema>>();
  const freeVarsMemo = nullRecord<Set<string>>();
  const resolving: string[] = [];

  // The `$var` names a lazy local transitively references, expanding names that
  // are themselves lazy locals. Memoized (the shared-ref write before recursion
  // also breaks reference cycles); the result is an over-approximation.
  function freeVarsOf(name: string): Set<string> {
    const cached = freeVarsMemo[name];
    if (cached) return cached;
    const result = new Set<string>();
    freeVarsMemo[name] = result;
    const direct = new Set<string>();
    collectVars(exprLocals[name]!, direct);
    for (const dv of direct) {
      result.add(dv);
      if (dv !== name && hasOwn(exprLocals, dv)) for (const fv of freeVarsOf(dv)) result.add(fv);
    }
    return result;
  }

  // The subset of `narrowings` that could actually change this local's type.
  function relevantFacts(name: string, narrowings: Record<string, Schema>): Record<string, Schema> {
    const fv = freeVarsOf(name);
    const out = nullRecord<Schema>();
    for (const k of Object.keys(narrowings)) if (fv.has(k)) out[k] = narrowings[k]!;
    return out;
  }

  // Synthesize a lazy local's type under the given facts (undefined ⇒ fast
  // path). Shares the `resolving` cycle guard across both paths.
  function resolveLocal(name: string, narrowings: Record<string, Schema> | undefined): Schema {
    if (resolving.includes(name)) {
      const cycle = [...resolving.slice(resolving.indexOf(name)), name].join(" -> ");
      report(at(options.bindingPath, name), `Circular local type dependency: ${cycle}`);
      return true;
    }
    resolving.push(name);
    try {
      return synth(exprLocals[name]!, {
        ...at(options.bindingPath, name),
        env,
        guards,
        narrowings,
      });
    } finally {
      resolving.pop();
    }
  }

  const env: TypeEnv = {
    lookupType(name: string, narrowings?: Record<string, Schema>): Schema | undefined {
      if (hasOwn(eager, name)) return eager[name];
      if (!hasOwn(exprLocals, name)) return parent?.lookupType(name, narrowings);

      // Lexical creation facts always apply; forcing-site facts augment them.
      // This matters when guard analysis asks for a local's current type through
      // `lookupType(name)` without explicitly forwarding `ctx.narrowings`.
      const active =
        Object.keys(creationNarrowings).length === 0
          ? (narrowings ?? {})
          : { ...creationNarrowings, ...narrowings };
      // Gate: only facts this local depends on matter. With none, the plain
      // memo answers — the genuinely no-narrowing path stays exactly as before.
      const relevant = Object.keys(active).length > 0 ? relevantFacts(name, active) : {};
      if (Object.keys(relevant).length === 0) {
        if (hasOwn(memo, name)) return memo[name];
        return (memo[name] = resolveLocal(name, undefined));
      }

      const bucket = (narrowedMemo[name] ??= nullRecord<Schema>());
      const key = stableStringify(relevant);
      if (hasOwn(bucket, key)) return bucket[key]!;
      return (bucket[key] = resolveLocal(name, relevant));
    },
  };

  if (options.checkFunctionBodies) {
    const functionCtx = { ...ctx, env, guards };
    for (const [name, body] of Object.entries(functionLocals)) {
      checkBody(body, at({ ...functionCtx, path: options.bindingPath.path }, name));
    }
  }

  return { env, guards };
}

function buildExpressionTypeScope(
  bindings: Record<string, JSONType>,
  parent: TypeEnv | null,
  ctx: CheckContext,
): TypeScopeResult {
  return buildLetrecTypeScope(bindings, parent, ctx, {
    reportUntypedFunctions: true,
    bindingPath: at(ctx, "$let"),
    checkFunctionBodies: true,
  });
}

function extendEagerTypeScope(
  bindings: Record<string, Schema>,
  parent: TypeEnv | null,
  ctx: CheckContext,
): TypeScopeResult {
  const guards = Object.assign(nullRecord<JSONType>(), ctx.guards);
  for (const name of Object.keys(bindings)) delete guards[name];
  const env: TypeEnv = {
    lookupType(name, narrowings) {
      return hasOwn(bindings, name) ? bindings[name] : parent?.lookupType(name, narrowings);
    },
  };
  return { env, guards };
}

function buildFunctionTypeScope(
  body: Record<string, JSONType>,
  layout: ParameterLayout,
  captures: Record<string, JSONType>,
  parent: TypeEnv | null,
  ctx: CheckContext,
  injectedSig?: Sig,
): FunctionTypeScopeResult {
  const captureCtx = withoutShadowedNarrowings(ctx, Object.keys(captures));
  const captureScope = buildLetrecTypeScope(captures, parent, captureCtx, {
    reportUntypedFunctions: true,
    bindingPath: at(ctx, "$captures"),
    checkFunctionBodies: true,
  });
  const sig = injectedSig ?? sigOf(body);
  const parameterBindings = bindParams(layout, sig, ctx);
  const functionCtx = withoutShadowedNarrowings(
    { ...captureCtx, env: captureScope.env, guards: captureScope.guards },
    Object.keys(parameterBindings.eager),
  );
  const scope = extendEagerTypeScope(parameterBindings.eager, captureScope.env, functionCtx);
  return {
    ...scope,
    parameterDefaults: parameterBindings.defaults,
    parameterBindingsValid: parameterBindings.valid,
    narrowings: functionCtx.narrowings,
  };
}

function buildModuleTypeScope(
  bindings: Record<string, JSONType>,
  ctx: CheckContext,
): TypeScopeResult {
  return buildLetrecTypeScope(bindings, null, ctx, {
    reportUntypedFunctions: false,
    bindingPath: ctx,
    checkFunctionBodies: false,
  });
}

// Structural type of literal JSON *data* (a `$raw` payload or a nested literal):
// scalars become `const`, composites become closed tuples/objects.
function synthData(v: JSONType): Schema {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) {
    const items = v.map(synthData);
    return { type: "array", prefixItems: items, items: false, minItems: items.length };
  }
  if (typeof v === "object") {
    const props: Record<string, Schema> = {};
    const required: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      props[k] = synthData(val);
      required.push(k);
    }
    return { type: "object", properties: props, required, additionalProperties: false };
  }
  return { const: v };
}

// Check the key of a computed/literal index against its container: array/tuple
// positions demand an `integer`, object/map keys a `string`. A key not provably
// in the right category is a hard `error` (§4.5) — an overlapping type like
// `number`, where flow could produce a valid integer, must be discharged with a
// guard or an `x!` assertion. Non-container / union / `any` targets and
// `any`/`never` keys are left permissive — the projection already degrades
// those to `any`.
function checkIndexKey(target: Schema, keyType: Schema, ctx: CheckContext): void {
  const t = resolveDeep(target, ctx.defs);
  const k = classifySchema(t);
  const cat =
    k === SchemaKind.Array || k === SchemaKind.Tuple
      ? "integer"
      : k === SchemaKind.Object
        ? "string"
        : null;
  if (cat === null) return;

  const kt = resolveDeep(keyType, ctx.defs);
  if (kt === true || kt === false) return; // any/never key: stay permissive

  const probe: Schema = { type: cat };
  if (isSubschema(keyType, probe, ctx.defs)) return; // definitely a valid key
  report(ctx, `Index key must be ${cat === "integer" ? "an integer" : "a string"}.`, {
    expected: probe,
    actual: keyType,
  });
}

// Reading a literal string field off a closed object that never declares it can
// only yield null at runtime — a masked typo, not a real access (§2). Report it
// as a hard error. Open / map / union-with-a-supplying-arm targets are left to
// `projectField`'s permissive projection (`isClosedMissingKey` returns false).
function reportClosedMissing(target: Schema, key: string, ctx: CheckContext): void {
  if (!isClosedMissingKey(target, key, ctx.defs)) return;
  report(ctx, `Field "${key}" does not exist on a closed object type.`, {
    severity: "error",
    actual: target,
  });
}

// The signature of a callee, or null when it can't be resolved statically
// (an unknown name — e.g. a builtin, deferred to the polymorphic layer — or a
// non-function value).
function resolveCalleeSig(callee: JSONType, ctx: CheckContext): Sig | null {
  let s: Schema;
  if (typeof callee === "string") {
    const looked = ctx.env.lookupType(callee);
    if (looked === undefined) return null; // unknown: defer (builtin layer)
    s = looked;
  } else {
    s = synth(callee, ctx);
  }
  return classifySchema(s) === SchemaKind.FnType ? fnShape(asObject(s)) : null;
}

// The param schema at position `i` (the rest element once past the fixed
// params), or null when the callee admits no param there.
function paramAt(sig: Sig, i: number): Schema | null {
  const fixed = fixedParamSchemas(sig);
  if (i < fixed.length) return fixed[i]!;
  return sig.rest ?? null;
}

// Report an arity mismatch, returning whether the count was acceptable. Callers
// use the result to skip downstream, arity-dependent checks (e.g. contextual
// lambda typing) that would otherwise pile spurious diagnostics onto the real
// arity error.
function checkArity(sig: Sig, argc: number, ctx: CheckContext): boolean {
  if (acceptsArgumentCount(sig, argc)) return true;

  const minimum = sig.required.length;
  const maximum = fixedParamSchemas(sig).length;
  const expected = formatArgumentCountExpectation(minimum, maximum, sig.rest !== undefined);
  report(ctx, `Expected ${expected}, got ${argc}.`);
  return false;
}

// Result type of a short-circuit `$and`/`$or` (docs/language.md): these are
// value-returning special forms, not boolean operators — the result is *an
// operand*. A non-final operand reaches the result only when it stops the chain
// (falsy for `$and`, truthy for `$or`), so it contributes just that slice of
// its type; the final operand contributes its whole type. Every operand is
// still synthesized (to surface nested errors). An empty `$and` evaluates to
// `true`, an empty `$or` to `false`.
function shortCircuitType(exprs: JSONType[], isAnd: boolean, ctx: CheckContext): Schema {
  const key = isAnd ? "$and" : "$or";
  if (exprs.length === 0) return { const: isAnd };
  const arms = exprs.map((e, i) => {
    const t = synth(e, at(ctx, `${key}[${i}]`));
    if (i === exprs.length - 1) return t;
    return isAnd ? restrictToFalsy(t, ctx.defs) : restrictToTruthy(t, ctx.defs);
  });
  return unionOf(arms);
}

// Arm traversal shared by `synth` (which unions the arm types) and `check`
// (which pushes the expected type into each arm). A single visitor per branch
// construct emits the control-flow lints exactly once and threads the same
// per-arm narrowing facts (§5.5; the frozen fact set is documented in
// `docs/narrowing.md`), then hands each arm's result expression and its
// narrowed context to `onArm`. Keeping this in one place is what lets check-mode
// push expectations into branches without re-implementing (and drifting from)
// the exhaustiveness / dead-case / narrowing logic.
type ArmVisitor = (result: JSONType, armCtx: CheckContext) => void;

function visitIfArms(
  c: { $if: JSONType; $then: JSONType; $else: JSONType },
  ctx: CheckContext,
  onArm: ArmVisitor,
): void {
  synth(c.$if, at(ctx, "$if"));
  // The guard narrows its subject in the matching arm (§5.5).
  const thenCtx = withNarrowings(ctx, factsFromCondition(c.$if, true, ctx));
  const elseCtx = withNarrowings(ctx, factsFromCondition(c.$if, false, ctx));
  onArm(c.$then, at(thenCtx, "$then"));
  onArm(c.$else, at(elseCtx, "$else"));
}

function visitCondArms(
  c: { $cond: [JSONType, JSONType][]; $else?: JSONType },
  ctx: CheckContext,
  onArm: ArmVisitor,
): void {
  // A `$cond` arm is reached only when every earlier condition was false, so it
  // accumulates their negated facts (dominating guards) plus its own positive
  // fact. `$else` inherits all conditions negated.
  let acc = ctx;
  c.$cond.forEach(([cond, result], i) => {
    synth(cond, at(acc, `$cond[${i}][0]`));
    const armCtx = withNarrowings(acc, factsFromCondition(cond, true, acc));
    onArm(result, at(armCtx, `$cond[${i}][1]`));
    acc = withNarrowings(acc, factsFromCondition(cond, false, acc));
  });
  if ("$else" in c) onArm(c.$else!, at(acc, "$else"));
}

function visitMatchArms(
  m: { $match: JSONType; $cases: [JSONType, JSONType][]; $else?: JSONType },
  ctx: CheckContext,
  onArm: ArmVisitor,
): void {
  const subjectType = synth(m.$match, at(ctx, "$match"));
  // The finite set of values the subject can take (an enum var, a union of
  // consts, or a `base.field` discriminant), or null when it isn't a finite
  // literal set. Drives the §5.6 exhaustiveness / dead-case lints below.
  const universe = caseUniverse(m.$match, subjectType, ctx);
  // Narrow the subject per case. Literal cases pin a bare var to that literal,
  // or refine a discriminated-union base for `match base.tag`. `$else` sees
  // every matched literal excluded.
  const matched: JSONType[] = [];
  const caseLiterals: JSONType[] = []; // every literal case value (for lints)
  let allLiteral = true;
  m.$cases.forEach(([caseVal, result], i) => {
    const lit = litOf(caseVal);
    if (lit === null) allLiteral = false;
    else {
      caseLiterals.push(lit.v);
      // Dead case: a literal the subject's finite universe can't produce, so it
      // can never match. A hard error (§4.5) — dead code the author should
      // remove or fix.
      if (universe !== null && !universe.some((u) => deepEqual(u, lit.v))) {
        report(
          at(ctx, `$cases[${i}][0]`),
          `Unreachable $match case: ${JSON.stringify(lit.v)} is not a possible value of the subject.`,
        );
      }
    }
    let armCtx = ctx;
    if (lit !== null) {
      const facts = matchCaseFact(m.$match, lit.v, ctx);
      armCtx = withNarrowings(ctx, facts);
      if (Object.keys(facts).length > 0) matched.push(lit.v);
    }
    onArm(result, at(armCtx, `$cases[${i}][1]`));
  });

  if ("$else" in m) {
    let elseCtx = ctx;
    if (matched.length > 0) {
      elseCtx = withNarrowings(ctx, matchElseFact(m.$match, matched, ctx));
    }
    onArm(m.$else!, at(elseCtx, "$else"));
  } else if (allLiteral && universe !== null) {
    // §5.6 exhaustiveness: no catch-all `$else`, yet the finite universe has
    // values no case covers — those inputs silently fall through. A hard error
    // (§4.5): add the missing cases or an explicit `$else`.
    const uncovered = universe.filter((u) => !caseLiterals.some((l) => deepEqual(l, u)));
    if (uncovered.length > 0) {
      report(
        ctx,
        `Non-exhaustive $match: unhandled case(s) ${uncovered.map((u) => JSON.stringify(u)).join(", ")}.`,
      );
    }
  }
}

// Infer a schema for an expression, accumulating diagnostics along the way.
function synth(expr: JSONType, ctx: CheckContext): Schema {
  switch (nodeKind(expr)) {
    case "scalar":
      return synthData(expr);

    case "array": {
      const arr = expr as JSONType[];
      const items = arr.map((e, i) => synth(e, at(ctx, `[${i}]`)));
      return { type: "array", prefixItems: items, items: false, minItems: items.length };
    }

    case "let": {
      const letNode = validateLet(expr as Record<string, JSONType>, ctx);
      if (letNode === null) return true;
      const letCtx = withoutShadowedNarrowings(ctx, Object.keys(letNode.bindings));
      const bindings = reachableLetBindings(letNode.bindings, letNode.result, ctx);
      const scope = buildExpressionTypeScope(bindings, ctx.env, letCtx);
      return synth(letNode.result, at({ ...letCtx, env: scope.env, guards: scope.guards }, "$in"));
    }

    case "object": {
      const o = expr as Record<string, JSONType>;
      const props: Record<string, Schema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(o)) {
        if (k === "$comment" && typeof v === "string") continue;
        props[k] = synth(v, at(ctx, k));
        required.push(k);
      }
      return { type: "object", properties: props, required, additionalProperties: false };
    }

    case "var": {
      const name = (expr as { $var: string }).$var;
      // A dominating guard may have refined this var within the current arm
      // (§5.5). The narrowed type is already intersected with the declared one,
      // so a hit is authoritative.
      const narrowed = ctx.narrowings?.[name];
      if (narrowed !== undefined) return narrowed;
      // A direct hit above; otherwise this may be an *indirect* narrowing — a
      // lazy local that references a narrowed var — so pass the active facts
      // down for re-synth under them (§5.5 M2).
      const t = ctx.env.lookupType(name, ctx.narrowings);
      // A miss is not necessarily an error: bare builtin/registry names resolve
      // as function values (§P4). Until the builtin layer lands, degrade to any,
      // but report the lost coverage so callers can distinguish it from a
      // fully-checked expression.
      if (t === undefined) {
        reportDegradation(ctx, `variable "${name}" is unresolved`);
        return true;
      }
      return t;
    }

    case "ref": {
      const fn = (expr as { $fn: JSONType }).$fn;
      if (typeof fn === "string") {
        const t = ctx.env.lookupType(fn);
        if (t === undefined) {
          reportDegradation(ctx, `function reference "${fn}" is unresolved`);
          return true;
        }
        return t;
      }
      return synth(fn, ctx);
    }

    case "body": {
      // A function value. Its type is its declared `$fnType`. When it declares
      // a signature, also verify its body against the declared return type here
      // — so the check fires for a standalone/`--expr` lambda or a function
      // literal in value position, not only for module bindings. Un-annotated
      // bodies (lambdas) can only be typed contextually (later milestone) and
      // are left to the caller's contextual typing.
      const body = expr as Record<string, JSONType>;
      if (sigOf(body) !== null) {
        checkBody(body, ctx);
      } else {
        analyzeCheckerFunctionBody(body, ctx);
        reportDegradation(ctx, "the function value has no declared signature");
      }
      return bodyFnTypeSchema(body);
    }

    case "call": {
      const call = expr as { $call: JSONType; $args: JSONType[] };
      const args = Array.isArray(call.$args) ? call.$args : [];
      // An inline unannotated body callee has no `$sig`, so
      // `resolveCalleeSig` cannot recover a function type. Infer parameter
      // types from its arguments and synthesize the structural `$return`.
      const callee = call.$call;
      if (isBody(callee) && sigOf(callee) === null) {
        const bctx = inlineCallBodyContext(callee, args, ctx);
        if (bctx === null) return true;
        return synth(callee.$return!, at(bctx, "$return"));
      }
      // A bare builtin name that no local/module binding shadows dispatches to
      // the polymorphic builtin layer (§5.3); user bindings still win. The
      // dispatcher is injected (see `CheckContext.synthCallableCall`) so this
      // core module never imports the builtin engine.
      if (
        typeof call.$call === "string" &&
        ctx.callables &&
        ctx.synthCallableCall &&
        call.$call in ctx.callables
      ) {
        if (ctx.env.lookupType(call.$call) === undefined) {
          return ctx.synthCallableCall(call.$call, ctx.callables[call.$call]!, args, ctx);
        }
      }
      const sig = resolveCalleeSig(call.$call, ctx);
      if (sig === null) {
        // Unknown callee: still walk args to surface nested errors.
        args.forEach((a, i) => synth(a, at(ctx, `$args[${i}]`)));
        reportDegradation(ctx, "the callee has no known function type");
        return true;
      }
      const arityOk = checkArity(sig, args.length, ctx);
      args.forEach((a, i) => {
        const param = paramAt(sig, i);
        if (param === null) synth(a, at(ctx, `$args[${i}]`));
        else if (!arityOk && isBody(a) && sigOf(a) === null) return;
        else check(a, param, at(ctx, `$args[${i}]`));
      });
      return sig.returns;
    }

    case "if": {
      const c = expr as { $if: JSONType; $then: JSONType; $else: JSONType };
      const arms: Schema[] = [];
      visitIfArms(c, ctx, (result, armCtx) => arms.push(synth(result, armCtx)));
      return unionOf(arms.map(widenLiteral));
    }

    case "cond": {
      const c = expr as { $cond: [JSONType, JSONType][]; $else?: JSONType };
      const arms: Schema[] = [];
      visitCondArms(c, ctx, (result, armCtx) => arms.push(synth(result, armCtx)));
      return unionOf(arms.map(widenLiteral));
    }

    case "match": {
      const m = expr as { $match: JSONType; $cases: [JSONType, JSONType][]; $else?: JSONType };
      const arms: Schema[] = [];
      visitMatchArms(m, ctx, (result, armCtx) => arms.push(synth(result, armCtx)));
      return unionOf(arms.map(widenLiteral));
    }

    case "and":
      return shortCircuitType((expr as { $and: JSONType[] }).$and, true, ctx);

    case "or":
      return shortCircuitType((expr as { $or: JSONType[] }).$or, false, ctx);

    case "nonnull": {
      const inner = synth((expr as { $nonnull: JSONType }).$nonnull, at(ctx, "$nonnull"));
      return removeType(inner, "null", ctx.defs);
    }

    case "ascription": {
      const ascription = expr as { $as: JSONType; $type: Schema };
      synth(ascription.$as, at(ctx, "$as"));
      if (!isRuntimeContractSchema(ascription.$type)) {
        report(
          at(ctx, "$type"),
          "checked ascription type is outside the runtime-contract fragment",
        );
      }
      const refs = new Set<string>();
      collectSchemaRefs(ascription.$type, refs);
      for (const name of refs) {
        if (!(name in ctx.defs)) {
          report(at(ctx, "$type"), `reference to undefined type "${name}"`);
        }
      }
      return ascription.$type;
    }

    case "get": {
      const g = expr as { $get: JSONType; $from: JSONType };
      // A dominating guard may have narrowed this exact access path (§5.5 M3),
      // e.g. `isNull(move.from)` refining `move.from` on the non-null arm. The
      // path fact is already intersected with the projected type, so a hit is
      // authoritative — mirror the `"var"` case and return it directly.
      const path = asPath(expr);
      if (path !== undefined && path !== null) {
        const narrowed = ctx.narrowings?.[path];
        if (narrowed !== undefined) return narrowed;
      }
      const target = synth(g.$from, at(ctx, "$from"));
      // A static nested string path (`x.a.b`, an array of keys) projects field
      // by field; keys are strings by construction, so no index-type check.
      // Each segment is closed-miss checked against the type reached so far, so
      // the first segment that can never carry its key is the reported one.
      if (Array.isArray(g.$get)) {
        let cur = target;
        for (const seg of g.$get) {
          if (typeof seg === "string") reportClosedMissing(cur, seg, at(ctx, "$get"));
          cur = projectField(cur, seg, ctx.defs);
        }
        return cur;
      }
      // A scalar literal key projects by value; still index-checked (e.g. to
      // reject `xs[2.5]`). A literal string key that a closed object never
      // declares is a typo — a hard error rather than a silent null (§2).
      if (nodeKind(g.$get) === "scalar") {
        checkIndexKey(target, synthData(g.$get), at(ctx, "$get"));
        if (typeof g.$get === "string") reportClosedMissing(target, g.$get, at(ctx, "$get"));
        return projectField(target, g.$get, ctx.defs);
      }
      // A computed key projects off the key's *type* (array `items` / tuple
      // element / map value), and its type is checked against the container.
      const keyType = synth(g.$get, at(ctx, "$get"));
      checkIndexKey(target, keyType, at(ctx, "$get"));
      return projectComputed(target, keyType, ctx.defs);
    }

    case "raw":
      return synthData((expr as { $raw: JSONType }).$raw);
  }
}

// Report an `actual ⊄ expected` mismatch as a hard error. §4.5 removed the
// former runtime-checkable "warning" downgrade for overlapping (narrowable)
// mismatches: an agent must prove the value with a recognized guard, or
// discharge it with an explicit checked boundary such as `x!` or `x as T`.
function reportMismatch(ctx: CheckContext, actual: Schema, expected: Schema): void {
  report(ctx, `${describe(actual)} is not assignable to ${describe(expected)}.`, {
    expected,
    actual,
  });
}

// The schema an expected *object* type assigns to key `k` (its own property,
// else its additional-properties rule), or null when the object forbids `k`.
// Mirrors `subsumption.ts`'s `supSchemaForKey` — reused here so check-mode can
// push the expected field type inward instead of comparing whole schemas.
function expectedFieldSchema(exp: Record<string, JSONType>, k: string): Schema | null {
  const props = properties(exp);
  if (k in props) return props[k]!;
  const mode = apMode(exp);
  if (mode.kind === "closed") return null;
  if (mode.kind === "open") return true;
  return mode.schema;
}

// Check an object *literal* against an expected object schema field by field, so
// a mismatch is pinpointed to the offending key (Priority 2 — Part A) rather
// than dumped as two whole schemas. This is parity-exact with `objectSubsumes`
// for object literals — which always synthesize to closed objects with every
// key required — while producing field-level diagnostics: a key the expected
// type forbids, a required key the literal omits, and a per-field type mismatch
// (recursively, so nested literals pinpoint too).
function checkObjectLiteral(
  o: Record<string, JSONType>,
  exp: Record<string, JSONType>,
  ctx: CheckContext,
): void {
  const present = new Set<string>();
  for (const [k, v] of Object.entries(o)) {
    if (k === "$comment" && typeof v === "string") continue;
    present.add(k);
    const fieldSchema = expectedFieldSchema(exp, k);
    if (fieldSchema === null) {
      report(at(ctx, k), `Field "${k}" is not permitted on the expected object type.`, {
        actual: synth(v, at(ctx, k)),
      });
      continue;
    }
    check(v, fieldSchema, at(ctx, k));
  }
  for (const rk of requiredKeys(exp)) {
    if (!present.has(rk)) {
      report(ctx, `Required field "${rk}" is missing.`, { expected: properties(exp)[rk] });
    }
  }
}

// Check an array *literal* against an expected array/tuple schema element by
// element, so a mismatch is pinpointed to the offending index (Priority 2 —
// Part A) rather than dumped as two whole schemas. A literal synthesizes to a
// closed tuple, so this mirrors `tupleSubsumesArray` / `tupleSubsumesTuple`:
//
// - Expected *array* (variable length): every element is checked against the
//   element schema; a shortfall against `minItems` is a length error.
// - Expected *tuple*: elements are checked positionally; a literal element past
//   a closed tuple's declared arity is "not permitted", and a declared position
//   the literal omits is "missing".
//
// Length/refinement constraints the structural pass can't phrase as an element
// error (`maxItems`, `uniqueItems`, an explicit tuple `minItems`/`maxItems`)
// fall back to the exact `isSubschema` verdict, so pass/fail stays identical to
// the synth-then-subsume path — only diagnostic locality improves.
function checkArrayLiteral(
  arr: JSONType[],
  exp: Record<string, JSONType>,
  ctx: CheckContext,
): void {
  const before = ctx.diagnostics.length;

  if (classifySchema(exp) === SchemaKind.Array) {
    const elem = itemsSchema(exp);
    arr.forEach((e, i) => check(e, elem, at(ctx, `[${i}]`)));
    if (
      ctx.diagnostics.length === before &&
      "minItems" in exp &&
      arr.length < (exp.minItems as number)
    ) {
      report(
        ctx,
        `Array has ${arr.length} element(s), but at least ${exp.minItems} are required.`,
        {
          expected: exp,
          actual: synth(arr, ctx),
        },
      );
    }
  } else {
    const pref = prefixItems(exp);
    const rest = tupleRest(exp); // null when the tuple is closed
    const upto = Math.max(arr.length, pref.length);
    for (let i = 0; i < upto; i++) {
      const supE = i < pref.length ? pref[i]! : rest;
      const hasElem = i < arr.length;
      if (supE === null) {
        // Closed tuple, position past its declared arity: an extra element.
        report(
          at(ctx, `[${i}]`),
          `Element ${i} is not permitted: the expected tuple has ${pref.length} element(s).`,
          {
            actual: synth(arr[i]!, at(ctx, `[${i}]`)),
          },
        );
      } else if (!hasElem) {
        report(ctx, `Tuple element ${i} is missing.`, { expected: supE });
      } else {
        check(arr[i]!, supE, at(ctx, `[${i}]`));
      }
    }
  }

  // Any remaining length/refinement constraint (maxItems, uniqueItems, explicit
  // tuple bounds) that the element-level pass didn't already flag: defer to the
  // exact subsumption verdict for parity, reporting at the array as a whole.
  if (ctx.diagnostics.length === before) {
    const actual = synth(arr, ctx);
    if (!isSubschema(actual, exp, ctx.defs)) reportMismatch(ctx, actual, exp);
  }
}

// Contextually type an *un-annotated* lambda against an expected function type
// (Priority 2 — Part A). An inline lambda usually omits its param/return
// annotations, so its own type is un-synthesizable (`bodyFnTypeSchema` → `any`);
// in checked position we inject the expected signature so its params bind to
// the expected param types, then reuse `checkBody` to verify
// its `$return` against the expected return type (recursing structurally) and
// recurse into its captures — exactly as an annotated body is checked. This
// is what finally lets a bare capability-record lambda (`() => task`) check
// against a field's declared `() -> Task` instead of erasing to `any` and then
// dumping a spurious `any ⊄ (fn)`. Parameter shape is exact; a mismatch is
// reported here rather than deferred, since the un-annotated lambda has no
// synthesizable type for the whole-schema fallback.
function checkLambda(
  body: Record<string, JSONType>,
  exp: Record<string, JSONType>,
  ctx: CheckContext,
): void {
  const analysis = analyzeCheckerFunctionBody(body, ctx);
  const layout = analysis.layout;
  if (layout === null) return;
  const shape = fnShape(exp);
  checkBody(body, ctx, shape, analysis);
}

// Type an unannotated inline function call by binding parameters to synthesized
// argument types. The caller then synthesizes or checks the structural
// `$return` in the completed function environment.
function inlineCallBodyContext(
  body: Record<string, JSONType>,
  args: JSONType[],
  ctx: CheckContext,
): CheckContext | null {
  const analysis = analyzeCheckerFunctionBody(body, ctx);
  const layout = analysis.layout;
  if (layout === null) return null;
  const hasRest = layout.rest !== null;
  const fixed = layout.fixedCount;
  const required = layout.requiredCount;

  // Arguments are outer expressions, synthesized in the caller's scope; their
  // types become the (otherwise un-annotated) params' supplied-value types.
  const argTypes = args.map((a, i) => synth(a, at(ctx, `$args[${i}]`)));
  const restTypes = argTypes.slice(fixed);
  const syntheticSig: Sig = {
    required: Array.from({ length: required }, (_, i) => argTypes[i] ?? true),
    optional: Array.from(
      { length: layout.omittableCount },
      (_, i) => argTypes[required + i] ?? true,
    ),
    returns: true,
    ...(hasRest ? { rest: restTypes.length === 0 ? true : unionOf(restTypes) } : {}),
  };
  if (!checkArity(syntheticSig, args.length, ctx)) return null;

  const { env, guards, narrowings, parameterDefaults, parameterBindingsValid } =
    buildFunctionTypeScope(body, layout, analysis.captures, ctx.env, ctx, syntheticSig);
  if (!parameterBindingsValid) return null;
  const bctx: CheckContext = { ...ctx, env, guards, narrowings };
  checkParameterDefaults(parameterDefaults, bctx);
  return bctx;
}

// Verify an expression against an expected schema, reporting on mismatch.
//
// Check-mode pushes the expected type structurally inward (Priority 2 — Part A)
// so diagnostics are local: composite *literals* recurse field/element-by-
// field/element, branch (`$if`/`$cond`/`$match`) arms are each checked against
// the expected type instead of being synthesized-then-unioned, and an
// un-annotated lambda is contextually typed against an expected function type.
// Because `unionOf(arms) ⊆ expected` iff every arm is (the union-sub rule in
// `subsumes`), per-arm checking is pass/fail-identical to the old whole-union
// comparison, but pinpoints the offending arm and avoids literal-union widening
// (`if … then 10 else 20` no longer widens to `10 | 20` before the check). Arm
// traversal reuses the `visit*Arms` visitors, so the same narrowing facts the
// `synth` cases thread reach each arm in checked position too. An unannotated
// inline function call has its `$return` checked against the expected type.
function check(expr: JSONType, expected: Schema, ctx: CheckContext): void {
  const kind = nodeKind(expr);

  if (kind === "let") {
    const letNode = validateLet(expr as Record<string, JSONType>, ctx);
    if (letNode === null) return;
    const letCtx = withoutShadowedNarrowings(ctx, Object.keys(letNode.bindings));
    const bindings = reachableLetBindings(letNode.bindings, letNode.result, ctx);
    const scope = buildExpressionTypeScope(bindings, ctx.env, letCtx);
    check(letNode.result, expected, at({ ...letCtx, env: scope.env, guards: scope.guards }, "$in"));
    return;
  }

  // Un-annotated inline lambda: contextually type it against an expected
  // function type (see `checkLambda`). A non-fn-type expected (`any`, or a
  // non-function) can't supply param types, so defer silently rather than emit
  // a spurious `any ⊄ …` for a value whose own type is un-synthesizable.
  if (kind === "body" && sigOf(expr as Record<string, JSONType>) === null) {
    const body = expr as Record<string, JSONType>;
    const exp = resolveDeep(expected, ctx.defs);
    if (classifySchema(exp) === SchemaKind.FnType) {
      checkLambda(body, asObject(exp), ctx);
    } else {
      analyzeCheckerFunctionBody(body, ctx);
    }
    return;
  }

  // For an unannotated inline function call in checked position, push the
  // expected type into `$return` so a mismatch is rooted there.
  if (kind === "call") {
    const callee = (expr as { $call: JSONType }).$call;
    if (isBody(callee) && sigOf(callee) === null) {
      const args = (expr as { $args?: JSONType[] }).$args;
      const bctx = inlineCallBodyContext(callee, Array.isArray(args) ? args : [], ctx);
      if (bctx === null) return;
      check(callee.$return!, expected, at(bctx, "$return"));
      return;
    }
  }

  // Branch constructs: push the expected type into each arm so arms are checked,
  // not synthesized-then-unioned.
  if (kind === "if") {
    visitIfArms(expr as Parameters<typeof visitIfArms>[0], ctx, (r, armCtx) =>
      check(r, expected, armCtx),
    );
    return;
  }
  if (kind === "cond") {
    visitCondArms(expr as Parameters<typeof visitCondArms>[0], ctx, (r, armCtx) =>
      check(r, expected, armCtx),
    );
    return;
  }
  if (kind === "match") {
    visitMatchArms(expr as Parameters<typeof visitMatchArms>[0], ctx, (r, armCtx) =>
      check(r, expected, armCtx),
    );
    return;
  }

  // Composite literal against a matching expected type: recurse element/field by
  // element/field. Only a single object/array expected takes this path; a union
  // / non-matching / `any` expected (which subsumes anything) falls through to
  // the exact synth-then-subsume comparison below.
  if (kind === "object" || kind === "array") {
    const exp = resolveDeep(expected, ctx.defs);
    const expK = classifySchema(exp);
    if (kind === "object" && expK === SchemaKind.Object) {
      checkObjectLiteral(expr as Record<string, JSONType>, asObject(exp), ctx);
      return;
    }
    if (kind === "array" && (expK === SchemaKind.Array || expK === SchemaKind.Tuple)) {
      checkArrayLiteral(expr as JSONType[], asObject(exp), ctx);
      return;
    }
  }

  const actual = synth(expr, ctx);
  if (!isSubschema(actual, expected, ctx.defs)) reportMismatch(ctx, actual, expected);
}

function describe(schema: Schema): string {
  return JSON.stringify(schema);
}

// Check a function body against its declared signature: build its capture and
// parameter scope, check defaults, then verify `$return` against the declared
// return type. Shared by the module entry (`checkModule`) and by `synth`'s body
// case, so a declared `-> type` is enforced wherever a typed function literal
// appears — a module binding, a value in `$return`/argument position, or a
// standalone expression checked via `checkExpr` (`--expr`).
function checkBody(
  body: Record<string, JSONType>,
  ctx: CheckContext,
  injectedSig?: Sig,
  priorAnalysis?: FunctionBodyStructureAnalysis,
): void {
  const analysis = priorAnalysis ?? analyzeCheckerFunctionBody(body, ctx);
  const layout = analysis.layout;
  if (layout === null) return;
  const declaredSig = sigOf(body);
  if (
    (injectedSig !== undefined &&
      !checkBodyParameterShape(layout, injectedSig, ctx, "Contextual signature")) ||
    (declaredSig !== null && !checkBodyParameterShape(layout, declaredSig, ctx, "Body signature"))
  ) {
    return;
  }
  const sig = injectedSig ?? declaredSig;
  const { env, guards, narrowings, parameterDefaults, parameterBindingsValid } =
    buildFunctionTypeScope(body, layout, analysis.captures, ctx.env, ctx, injectedSig);
  if (!parameterBindingsValid) return;
  const bctx: CheckContext = { ...ctx, env, guards, narrowings };
  checkParameterDefaults(parameterDefaults, bctx);
  check(body.$return!, sig?.returns ?? true, at(bctx, "$return"));
}

// A body's normalized declaration must agree with both its own signature and
// any contextually supplied signature before schemas are aligned to names.
// Returning false lets the caller stop the body after the single declaration
// diagnostic instead of cascading through a scope built from shifted slots.
function checkBodyParameterShape(
  layout: ParameterLayout,
  sig: Sig,
  ctx: CheckContext,
  source: "Body signature" | "Contextual signature",
): boolean {
  if (parameterShapeMatches(layout, sig)) return true;
  const expected = describeSigShape(sig);
  const actual = describeParameterLayout(layout);
  report(at(ctx, "$params"), `${source} expects ${expected}; body declares ${actual}.`);
  return false;
}

export {
  analyzeCheckerFunctionBody,
  parameterShapeMatches,
  checkBodyParameterShape,
  describeParameterLayout,
  describeSigShape,
  acceptsArgumentCount,
  buildFunctionTypeScope,
  buildModuleTypeScope,
  reachableLetBindingNames,
  checkParameterDefaults,
  synth,
  paramAt,
  checkArity,
  reportMismatch,
  check,
  checkBody,
};
