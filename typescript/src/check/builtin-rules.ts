// The polymorphic layer. Builtin signatures live in a language-agnostic table
// (`spec/builtins.json`, see docs/builtin-signatures.md) so all implementations
// share one source of truth and don't drift. That table speaks a small
// *builtin-only* dialect on top of the user-facing schema fragment:
//
//   * type variables — `{ "$tvar": "T" }` — instantiated per call site;
//   * portable fallback overloads — every callable has a non-empty signature
//     set, tried in order (covers integer preservation and ad-hoc overloads);
//   * variadic `rest` — reused from the `$fnType` shape;
//   * an optional namespaced rule — for precision no data template can capture,
//     implemented through an injected host-language registry.
//
// The table is pure data; the code below is the (per-impl) engine that reads
// it: choose an overload, infer type variables from the concrete argument
// schemas, push the instantiated parameter types into inline-lambda arguments
// (contextual typing, §4.3), and instantiate the return.

import type { JSONType } from "../types";
import type {
  TVarNode,
  Bindings,
  BuiltinSig,
  BuiltinEntry,
  BuiltinTypeRuleServicesV1,
} from "./builtin-types";
import { BuiltinTypeRuleContractError } from "./callable-rules";
import { buildTypeScope, check, checkArity, paramAt, reportMismatch, synth } from "./checker";
import {
  at,
  type CheckContext,
  type Diagnostic,
  isBody,
  report,
  reportCoverageDegradation,
  reportDegradation,
  sigOf,
  stableStringify,
} from "./context";
import {
  type Schema,
  isSchemaObject,
  classifySchema,
  SchemaKind,
  resolveRef,
  resolveDeep,
  itemsSchema,
  asObject,
  tupleRest,
  unionArms,
  unionOf,
  prefixItems,
  fnShape,
  properties,
  apMode,
  widenLiteral,
} from "./schema";
import { isSubschema } from "./subsumption";

function isTVar(s: Schema): s is TVarNode {
  return isSchemaObject(s) && "$tvar" in s;
}

// Does the template mention a type variable anywhere? Checked recursively so we
// see vars nested in a callback's return template (e.g. `flatMap`'s `U[]`), not
// just a bare top-level tvar (e.g. `map`'s `U`). A return that mentions a var is
// *inferred* from the lambda body (binding output vars, joining into vars an
// input already pinned — the `reduce` accumulator); a fully concrete return
// (e.g. `filter`'s `boolean`, `sort`'s `number`) is instead strictly checked.
function mentionsTVar(s: Schema): boolean {
  if (isTVar(s)) return true;
  if (Array.isArray(s)) return s.some(mentionsTVar);
  if (isSchemaObject(s)) return Object.values(s).some((v) => mentionsTVar(v as Schema));
  return false;
}

function collectTVars(s: Schema, into: Set<string> = new Set()): Set<string> {
  if (isTVar(s)) {
    into.add(s.$tvar);
  } else if (Array.isArray(s)) {
    for (const item of s) collectTVars(item, into);
  } else if (isSchemaObject(s)) {
    for (const value of Object.values(s)) collectTVars(value as Schema, into);
  }
  return into;
}

// Only an unannotated inline body needs contextual typing. A body with `$sig`
// is a concrete function value whose declared type must survive unchanged.
function isContextualLambda(expr: JSONType): expr is Record<string, JSONType> {
  return isBody(expr) && sigOf(expr) === null;
}

// Substitute bound type variables throughout a signature template. An unbound
// variable collapses to `any` — a template hole no argument pinned down.
function instantiate(schema: Schema, bindings: Bindings): Schema {
  if (isTVar(schema)) {
    const bound = bindings[schema.$tvar];
    return bound === undefined ? true : bound;
  }
  if (Array.isArray(schema)) return schema.map((x) => instantiate(x, bindings));
  if (isSchemaObject(schema)) {
    if (Array.isArray(schema.anyOf)) {
      return unionOf((schema.anyOf as Schema[]).map((x) => instantiate(x, bindings)));
    }
    const out: Record<string, JSONType> = {};
    for (const [k, v] of Object.entries(schema)) out[k] = instantiate(v as Schema, bindings);
    return out;
  }
  return schema;
}

// The element schema of a concrete array/tuple, for matching an `array items T`
// template against an argument. Null when the value isn't array-shaped.
function elementSchemaOf(concrete: Schema, ctx: CheckContext): Schema | null {
  let t = concrete;
  while (classifySchema(t) === SchemaKind.Ref) t = resolveRef(t, ctx.defs);
  const k = classifySchema(t);
  if (k === SchemaKind.Array) return itemsSchema(asObject(t));
  if (k === SchemaKind.Tuple) {
    const o = asObject(t);
    const rest = tupleRest(o);
    const elements = rest === null ? prefixItems(o) : [...prefixItems(o), rest];
    return unionOf(elements.map(widenLiteral));
  }
  return null;
}

// Match a signature template against a concrete argument schema: bind type
// variables where the template has them, and verify compatibility where it
// doesn't. Returns false only on a definite concrete mismatch, which lets
// overload selection reject an arm.
function unifyTemplateInto(
  template: Schema,
  concrete: Schema,
  bindings: Bindings,
  ctx: CheckContext,
): boolean {
  if (isTVar(template)) {
    const name = template.$tvar;
    bindings[name] = name in bindings ? unionOf([bindings[name]!, concrete]) : concrete;
    return true;
  }

  const resolved = resolveDeep(concrete, ctx.defs);

  // A concrete union must fit as a whole. Walk every arm into the same binding
  // environment so variables collect the union of the schemas seen per arm.
  const concreteArms = unionArms(resolved);
  if (concreteArms !== null) {
    return concreteArms.every((arm) => unifyTemplateInto(template, arm, bindings, ctx));
  }

  const tk = classifySchema(template);

  if (tk === SchemaKind.Array) {
    if (resolved === true) return true;
    const elem = elementSchemaOf(resolved, ctx);
    if (elem === null) return false;
    return unifyTemplateInto(itemsSchema(asObject(template)), elem, bindings, ctx);
  }

  if (tk === SchemaKind.Tuple) {
    if (resolved === true) return true;
    const ck = classifySchema(resolved);
    if (ck !== SchemaKind.Tuple) return false;

    const t = asObject(template);
    const c = asObject(resolved);
    const tp = prefixItems(t);
    const cp = prefixItems(c);
    const tr = tupleRest(t);
    const cr = tupleRest(c);

    // A prefix slot can be supplied by the other tuple's rest. Missing and
    // surplus positions are left to the final compatibility check below.
    for (let i = 0; i < Math.max(tp.length, cp.length); i++) {
      const ts = tp[i] ?? tr;
      const cs = cp[i] ?? cr;
      if (ts !== null && ts !== undefined && cs !== null && cs !== undefined) {
        if (!unifyTemplateInto(ts, cs, bindings, ctx)) return false;
      }
    }
    if (tr !== null && cr !== null && !unifyTemplateInto(tr, cr, bindings, ctx)) return false;

    return isSubschema(resolved, instantiate(template, bindings), ctx.defs);
  }

  if (tk === SchemaKind.Object) {
    if (resolved === true) return true;
    if (classifySchema(resolved) !== SchemaKind.Object) return false;

    const t = asObject(template);
    const c = asObject(resolved);
    const tp = properties(t);
    const cp = properties(c);
    const cm = apMode(c);

    // Named template properties bind from the concrete property's own schema,
    // or from the concrete additional-properties rule when the key is not
    // explicitly declared there.
    for (const [key, ts] of Object.entries(tp)) {
      const cs =
        key in cp ? cp[key]! : cm.kind === "map" ? cm.schema : cm.kind === "open" ? true : null;
      if (cs !== null && !unifyTemplateInto(ts, cs, bindings, ctx)) return false;
    }

    const tm = apMode(t);
    if (tm.kind === "map") {
      // additionalProperties applies only to keys the template does not name.
      // For a closed concrete record this joins all such field types; a map
      // contributes its tail schema, and an open object degrades the variable
      // to `any`. An empty closed tail contributes `never`, matching the
      // element type inferred from an empty tuple.
      const unmatched = Object.entries(cp).filter(([key]) => !(key in tp));
      for (const [, cs] of unmatched) {
        if (!unifyTemplateInto(tm.schema, cs, bindings, ctx)) return false;
      }
      if (cm.kind === "map" && !unifyTemplateInto(tm.schema, cm.schema, bindings, ctx))
        return false;
      if (cm.kind === "open" && !unifyTemplateInto(tm.schema, true, bindings, ctx)) return false;
      if (
        cm.kind === "closed" &&
        unmatched.length === 0 &&
        !unifyTemplateInto(tm.schema, false, bindings, ctx)
      )
        return false;
    }

    return isSubschema(resolved, instantiate(template, bindings), ctx.defs);
  }

  if (tk === SchemaKind.FnType) {
    if (resolved === true) return true;
    if (classifySchema(resolved) !== SchemaKind.FnType) return false;
    const a = fnShape(asObject(template));
    const b = fnShape(asObject(resolved));
    if (a.params.length !== b.params.length) return false;
    // Callback parameters are contravariant constraints, not inference
    // sources. Bind output variables from the covariant return, then validate
    // the complete concrete function against the finally instantiated type.
    // Data arguments therefore determine T in `(T) -> U`, while the callback
    // return can still determine U.
    return unifyTemplateInto(a.returns, b.returns, bindings, ctx);
  }

  // No type variables to bind here — a plain compatibility check.
  return isSubschema(resolved, instantiate(template, bindings), ctx.defs);
}

// Structural matching can bind variables before a later part of the same
// template fails. Keep those tentative bindings isolated and publish them only
// when the complete template matches.
function unifyTemplate(
  template: Schema,
  concrete: Schema,
  bindings: Bindings,
  ctx: CheckContext,
): boolean {
  const candidate = { ...bindings };
  if (!unifyTemplateInto(template, concrete, candidate, ctx)) return false;
  Object.assign(bindings, candidate);
  return true;
}

// Type an inline-lambda argument under the (instantiated) parameter types the
// builtin supplies, returning its synthesized body type. A lambda may ignore
// trailing callback arguments, but it cannot require more fixed arguments than
// the builtin supplies. A rest parameter collects the remaining supplied
// schemas rather than silently degrading to `any[]`. Returns null after an
// arity error so the body is not checked under a bogus scope.
function inferLambdaReturn(body: JSONType, expectedFn: Schema, ctx: CheckContext): Schema | null {
  const shape = fnShape(asObject(expectedFn));
  const params = Array.isArray((body as Record<string, JSONType>).$params)
    ? ((body as Record<string, JSONType>).$params as JSONType[])
    : [];
  const restIndex = params.findIndex((p) => typeof p === "string" && p.startsWith("..."));
  const fixed = restIndex === -1 ? params.length : restIndex;
  if (fixed > shape.params.length) {
    report(
      ctx,
      `Inline callback declares ${fixed} fixed parameter(s), but the builtin supplies at most ${shape.params.length}.`,
    );
    return null;
  }

  const remaining = shape.params.slice(fixed);
  if (shape.rest !== undefined) remaining.push(shape.rest);
  const withSig: Record<string, JSONType> = {
    ...(body as Record<string, JSONType>),
    $sig: {
      params: shape.params.slice(0, fixed),
      ...(restIndex !== -1 ? { rest: unionOf(remaining) } : {}),
      returns: shape.returns,
    },
  };
  const { env, guards } = buildTypeScope(withSig, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env, guards, path: [...ctx.path, "$return"] };
  return synth((body as Record<string, JSONType>).$return!, bctx);
}

// Trial: can this overload accept the arguments? Synthesizes every concrete
// argument first, then binds from all of them before validating any one against
// its instantiated parameter. Lambdas are deferred to `applyOverload`. Returns
// the bindings on success, null on a concrete mismatch or arity failure. Runs
// silently — diagnostics are emitted only for the chosen overload.
function tryBindOverload(
  sig: BuiltinSig,
  argExprs: JSONType[],
  ctx: CheckContext,
): Bindings | null {
  if (sig.rest === undefined) {
    if (argExprs.length !== sig.params.length) return null;
  } else if (argExprs.length < sig.params.length) {
    return null;
  }
  const bindings: Bindings = {};
  const silent: CheckContext = { ...ctx, diagnostics: [] };
  const concrete: { param: Schema; schema: Schema }[] = [];

  for (let i = 0; i < argExprs.length; i++) {
    const param = paramAt(sig, i);
    if (param === null) return null;
    if (isContextualLambda(argExprs[i]!)) continue;
    concrete.push({ param, schema: synth(argExprs[i]!, silent) });
  }

  for (const arg of concrete) {
    if (!unifyTemplate(arg.param, arg.schema, bindings, ctx)) return null;
  }
  for (const arg of concrete) {
    if (arg.schema !== true && !isSubschema(arg.schema, instantiate(arg.param, bindings), ctx.defs))
      return null;
  }

  return bindings;
}

// Real pass over a chosen overload: emit diagnostics, type inline lambdas with
// the inferred type variables, and return the instantiated result schema.
function applyOverload(
  sig: BuiltinSig,
  argExprs: JSONType[],
  ctx: CheckContext,
  skipContextualCallbacks: ReadonlySet<number> = new Set(),
): Schema {
  const arityOk = checkArity(sig, argExprs.length, ctx);
  const bindings: Bindings = {};
  const lambdas: number[] = [];
  const concrete: { param: Schema; schema: Schema; ctx: CheckContext }[] = [];
  const finalLambdaValidations: {
    expr: JSONType;
    param: Schema;
    ctx: CheckContext;
    sharedVars: string[];
    initialBindings: Record<string, Schema | undefined>;
  }[] = [];

  // Pass 1 — synthesize every concrete arg without validating against bindings
  // that later arguments may still widen.
  for (let i = 0; i < argExprs.length; i++) {
    const param = paramAt(sig, i);
    const actx = at(ctx, `$args[${i}]`);
    if (param === null) {
      synth(argExprs[i]!, actx); // surplus arg (no param): still walk for errors
      continue;
    }
    if (isContextualLambda(argExprs[i]!)) {
      if (!skipContextualCallbacks.has(i)) lambdas.push(i);
      continue;
    }
    concrete.push({ param, schema: synth(argExprs[i]!, actx), ctx: actx });
  }

  // Pass 2 — collect one final binding environment from all concrete args.
  for (const arg of concrete) {
    unifyTemplate(arg.param, arg.schema, bindings, ctx);
  }

  // Pass 3 — validate every concrete arg against that final environment.
  for (const arg of concrete) {
    const inst = instantiate(arg.param, bindings);
    if (arg.schema !== true && !isSubschema(arg.schema, inst, ctx.defs)) {
      reportMismatch(arg.ctx, arg.schema, inst);
    }
  }

  // Pass 4 — lambdas, now that input variables are known. Their returns bind
  // the output variables (or are checked against a concrete return template).
  // Skip this entirely when arity was wrong: a missing argument leaves input
  // type variables unbound, so lambda params degrade to `any` and typing the
  // body emits a spurious mismatch stacked on top of the real arity error
  // (the cascading-diagnostics gap). One user mistake, one diagnostic.
  for (const i of arityOk ? lambdas : []) {
    const param = paramAt(sig, i)!;
    // A lambda supplied where the expected param isn't a function type (e.g.
    // args swapped, `map([1,2,3], (n) => n + 1)`) can't be contextually typed.
    // Report the assignability error instead of destructuring an absent
    // `$fnType`, which used to throw. Since an un-annotated lambda has no
    // synthesizable type, describe it by its declared arity so the mismatch
    // fires reliably rather than degrading to `any`.
    if (classifySchema(param) !== SchemaKind.FnType) {
      const lambda = argExprs[i] as Record<string, JSONType>;
      const arity = Array.isArray(lambda.$params) ? lambda.$params.length : 0;
      const actual: Schema = {
        $fnType: { params: Array.from({ length: arity }, () => true), returns: true },
      };
      reportMismatch(at(ctx, `$args[${i}]`), actual, instantiate(param, bindings));
      continue;
    }
    const shape = fnShape(asObject(param));
    const expectedFn: Schema = {
      $fnType: {
        params: shape.params.map((p) => instantiate(p, bindings)),
        ...(shape.rest !== undefined ? { rest: instantiate(shape.rest, bindings) } : {}),
        returns: true,
      },
    };
    const actx = at(ctx, `$args[${i}]`);
    const ret = inferLambdaReturn(argExprs[i]!, expectedFn, actx);
    if (ret === null) continue;
    if (mentionsTVar(shape.returns)) {
      const paramVars = collectTVars({
        $fnType: {
          params: shape.params,
          ...(shape.rest !== undefined ? { rest: shape.rest } : {}),
          returns: false,
        },
      });
      const sharedVars = [...collectTVars(shape.returns)].filter((name) => paramVars.has(name));
      const initialBindings = Object.fromEntries(
        sharedVars.map((name) => [name, bindings[name]]),
      ) as Record<string, Schema | undefined>;
      if (!unifyTemplate(shape.returns, ret, bindings, ctx)) {
        reportMismatch(at(actx, "$return"), ret, instantiate(shape.returns, bindings));
      }
      if (sharedVars.length > 0) {
        finalLambdaValidations.push({
          expr: argExprs[i]!,
          param,
          ctx: actx,
          sharedVars,
          initialBindings,
        });
      }
    } else {
      const inst = instantiate(shape.returns, bindings);
      if (!isSubschema(ret, inst, ctx.defs)) reportMismatch(at(actx, "$return"), ret, inst);
    }
  }

  // A callback return may widen a variable that also appears in its parameter
  // types (`reduce`'s U is the important case). The first pass checked the body
  // under the pre-widened parameter, so validate it once more under the final
  // bindings that later runtime calls may actually supply. This pass is
  // validation-only: its return never feeds back into `bindings`.
  for (const validation of finalLambdaValidations) {
    const changed = validation.sharedVars.some(
      (name) =>
        stableStringify(validation.initialBindings[name]) !== stableStringify(bindings[name]),
    );
    if (!changed) continue;

    const shape = fnShape(asObject(validation.param));
    const expectedFn: Schema = {
      $fnType: {
        params: shape.params.map((p) => instantiate(p, bindings)),
        ...(shape.rest !== undefined ? { rest: instantiate(shape.rest, bindings) } : {}),
        returns: instantiate(shape.returns, bindings),
      },
    };
    const diagnostics: Diagnostic[] = [];
    const vctx: CheckContext = { ...validation.ctx, diagnostics };
    const ret = inferLambdaReturn(validation.expr, expectedFn, vctx);
    if (ret !== null) {
      const expectedReturn = instantiate(shape.returns, bindings);
      if (!isSubschema(ret, expectedReturn, ctx.defs)) {
        reportMismatch(at(vctx, "$return"), ret, expectedReturn);
      }
    }

    const existing = new Set(ctx.diagnostics.map(stableStringify));
    for (const diagnostic of diagnostics) {
      const key = stableStringify(diagnostic);
      if (!existing.has(key)) {
        ctx.diagnostics.push(diagnostic);
        existing.add(key);
      }
    }
  }

  return instantiate(sig.returns, bindings);
}

// Render a signature's parameter list as `(p0, p1, ...rest)` for a diagnostic.
function paramList(sig: BuiltinSig): string {
  const parts = sig.params.map((p) => JSON.stringify(p));
  if (sig.rest !== undefined) parts.push(`...${JSON.stringify(sig.rest)}`);
  return `(${parts.join(", ")})`;
}

// When *no* overload of a multi-arm builtin accepts the arguments, report the
// whole failed overload set — not just the first arm. Reporting only `entry[0]`
// (the old `?? entry[0]` fallback) means a call like `length(123)` complains it
// wanted an `array` and never mentions the equally-valid `string` arm. We list
// every arm's parameter signature and attach a structured `expected` (an
// `anyOf` of the arms as `$fnType`s) / `actual` (the call's own arg shape) so
// the JSON diagnostics stay machine-readable. Arguments are still synthesized in
// the real context so nested errors inside them surface exactly once.
function reportNoOverload(
  name: string,
  overloads: BuiltinSig[],
  argExprs: JSONType[],
  ctx: CheckContext,
): Schema {
  const actualParams = argExprs.map((a, i) => synth(a, at(ctx, `$args[${i}]`)));
  const actual: Schema = { $fnType: { params: actualParams, returns: true } };
  const expected: Schema = {
    anyOf: overloads.map((ov) => ({
      $fnType: {
        params: ov.params,
        ...(ov.rest !== undefined ? { rest: ov.rest } : {}),
        returns: ov.returns,
      },
    })),
  };
  const got = `(${actualParams.map((p) => JSON.stringify(p)).join(", ")})`;
  const arms = overloads.map(paramList).join(" or ");
  report(ctx, `No overload of "${name}" matches arguments ${got}; expected ${arms}.`, {
    expected,
    actual,
  });
  // Best-effort return so downstream checking continues: the first arm's return
  // with no bindings (unbound type variables collapse to `any`).
  return instantiate(overloads[0]!.returns, {});
}

function createRuleServices(
  argExprs: JSONType[],
  ctx: CheckContext,
  contextualizedCallbacks: Set<number>,
): BuiltinTypeRuleServicesV1 {
  const ruleContext = (options: { argumentIndex?: number; path?: string[] } = {}): CheckContext => {
    let target = ctx;
    if (options.argumentIndex !== undefined) {
      target = at(target, `$args[${options.argumentIndex}]`);
    }
    for (const segment of options.path ?? []) target = at(target, segment);
    return target;
  };

  return {
    apiVersion: 1,
    defs: ctx.defs,
    effects: ctx.effects,
    synthArgument: (index) => {
      const expr = argExprs[index];
      if (expr === undefined) return true;
      return synth(expr, { ...at(ctx, `$args[${index}]`), diagnostics: [] });
    },
    checkArgument: (index, expected) => {
      const expr = argExprs[index];
      if (expr !== undefined) check(expr, expected, at(ctx, `$args[${index}]`));
    },
    contextualTypeCallback: (index, expectedFn) => {
      const expr = argExprs[index];
      if (expr === undefined || !isContextualLambda(expr)) return null;
      contextualizedCallbacks.add(index);
      const diagnostics: Diagnostic[] = [];
      const result = inferLambdaReturn(expr, expectedFn, {
        ...at(ctx, `$args[${index}]`),
        diagnostics,
      });
      const existing = new Set(ctx.diagnostics.map(stableStringify));
      for (const diagnostic of diagnostics) {
        const key = stableStringify(diagnostic);
        if (!existing.has(key)) {
          ctx.diagnostics.push(diagnostic);
          existing.add(key);
        }
      }
      return result;
    },
    resolveSchema: (schema) => resolveDeep(schema, ctx.defs),
    instantiateSchema: instantiate,
    reportError: (message, options = {}) => {
      const extra: Partial<Diagnostic> = {};
      if (options.expected !== undefined) extra.expected = options.expected;
      if (options.actual !== undefined) extra.actual = options.actual;
      report(ruleContext(options), message, extra);
    },
    reportAnyDegradation: (reason) => reportDegradation(ctx, reason),
    reportCoverageDegradation: (reason) => reportCoverageDegradation(ctx, reason),
  };
}

// Dispatch every callable through its portable fallback first, then let an
// optional injected rule add diagnostics or refine that result.
function synthBuiltinCall(
  name: string,
  entry: BuiltinEntry,
  argExprs: JSONType[],
  ctx: CheckContext,
): Schema {
  const rule = entry.rule === undefined ? undefined : ctx.typeRules?.[entry.rule];
  const fallbackDiagnostics: Diagnostic[] = [];
  const fallbackContext = rule === undefined ? ctx : { ...ctx, diagnostics: fallbackDiagnostics };
  const chosen = entry.signatures.find((ov) => tryBindOverload(ov, argExprs, ctx) !== null);
  const fallbackMatched = chosen !== undefined;
  let fallbackResult: Schema;

  // No arm fits and there's more than one: report the whole overload set rather
  // than blaming (and pinpointing against) just the first arm. A single-arm
  // builtin still falls through to `applyOverload`, whose per-argument, arity,
  // and return diagnostics are already precise.
  if (chosen === undefined && entry.signatures.length > 1) {
    fallbackResult = reportNoOverload(name, entry.signatures, argExprs, fallbackContext);
  } else {
    fallbackResult = applyOverload(chosen ?? entry.signatures[0]!, argExprs, fallbackContext);
  }

  if (entry.rule === undefined) return fallbackResult;
  if (rule === undefined) {
    reportCoverageDegradation(ctx, `callable rule "${entry.rule}" is unavailable`);
    return fallbackResult;
  }

  const contextualizedCallbacks = new Set<number>();
  const ruleDiagnostics: Diagnostic[] = [];
  const ruleContext = { ...ctx, diagnostics: ruleDiagnostics };
  const result = rule(
    { name, args: argExprs, fallbackResult, fallbackMatched },
    createRuleServices(argExprs, ruleContext, contextualizedCallbacks),
  );
  // Once a rule contextually rechecks a callback, rerun the fallback's
  // diagnostic pass without that callback. This retains diagnostics from other
  // arguments while avoiding stale errors produced under the fallback's broad
  // callback parameter types. Re-running is necessary because lazy locals can
  // report at binding-relative paths that cannot be filtered reliably.
  let retainedFallback = fallbackDiagnostics;
  if (contextualizedCallbacks.size > 0) {
    retainedFallback = [];
    applyOverload(
      chosen ?? entry.signatures[0]!,
      argExprs,
      {
        ...ctx,
        diagnostics: retainedFallback,
      },
      contextualizedCallbacks,
    );
  }
  const existing = new Set(ctx.diagnostics.map(stableStringify));
  for (const diagnostic of [...retainedFallback, ...ruleDiagnostics]) {
    const key = stableStringify(diagnostic);
    if (!existing.has(key)) {
      ctx.diagnostics.push(diagnostic);
      existing.add(key);
    }
  }
  if (!isSubschema(result, fallbackResult, ctx.defs)) {
    throw new BuiltinTypeRuleContractError(entry.rule, fallbackResult, result);
  }
  return result;
}

export { synthBuiltinCall };
