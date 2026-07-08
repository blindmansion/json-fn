// Two scopes, as in the design (§D of the plan):
//   * Type-name scope: `resolveRef` over `ctx.defs` (flat; recursion guard
//     lives in `subsumes`).
//   * Term scope (Γ): this function, the structural mirror of `buildScope`.
//
// Params bind eagerly from the declared `$sig`. Sibling function declarations
// bind eagerly to their `$fnType`. Other locals (un-annotated expression
// bindings) are typed *lazily* at their first lookup — reusing the shape of
// `getVar`'s `resolvingVars` cycle guard — because the dominant idiom binds
// everything in a `where` block and only some bindings are ever forced.

import type { JSONType } from "../types";
import { asVarName, litOf, nodeKind } from "./ast";
import { synthBuiltinCall } from "./builtin-rules";
import {
  at,
  bindingKeys,
  bodyFnTypeSchema,
  isBody,
  report,
  sigOf,
  type CheckContext,
  type Severity,
  type Sig,
  type TypeEnv,
} from "./context";
import {
  withNarrowings,
  factsFromCondition,
  currentType,
  restrictToLiteral,
  excludeLiteral,
} from "./narrowing";
import {
  apMode,
  asObject,
  classifySchema,
  fnShape,
  isSchemaObject,
  itemsSchema,
  prefixItems,
  properties,
  resolveRef,
  SchemaKind,
  tupleRest,
  unionArms,
  unionOf,
  type Defs,
  type Schema,
} from "./schema";
import { isSubschema } from "./subsumption";

// The schema of property `k` in an object schema, for destructuring a param.
function propertySchema(objSchema: Schema | undefined, k: string): Schema | undefined {
  if (objSchema === undefined || !isSchemaObject(objSchema)) return undefined;
  const props = properties(objSchema);
  if (k in props) return props[k];
  const mode = apMode(objSchema);
  if (mode.kind === "map") return mode.schema;
  if (mode.kind === "open") return true;
  return undefined;
}

// Bind a body's `$params` to their declared `$sig` schemas.
function bindParams(params: JSONType[], sig: Sig | null, eager: Record<string, Schema>): void {
  const sigParams = sig?.params ?? [];
  const rest = sig?.rest;
  for (let i = 0; i < params.length; i++) {
    const slot = params[i]!;
    if (typeof slot === "string") {
      if (slot.startsWith("...")) {
        eager[slot.slice(3)] = { type: "array", items: rest ?? true };
        break;
      }
      eager[slot] = sigParams[i] ?? true;
    } else if (isSchemaObject(slot) && Array.isArray(slot.$fields)) {
      const objSchema = sigParams[i];
      for (const f of slot.$fields as string[]) {
        eager[f] = propertySchema(objSchema, f) ?? true;
      }
    }
  }
}

function buildTypeScope(
  body: Record<string, JSONType>,
  parent: TypeEnv | null,
  ctx: CheckContext,
): TypeEnv {
  const eager: Record<string, Schema> = {};
  const exprLocals: Record<string, JSONType> = {};

  const sig = sigOf(body);
  const params = Array.isArray(body.$params) ? (body.$params as JSONType[]) : [];
  bindParams(params, sig, eager);

  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) {
      eager[key] = bodyFnTypeSchema(val); // sibling function: eager `$fnType`
    } else {
      exprLocals[key] = val; // un-annotated local: typed lazily below
    }
  }

  const memo: Record<string, Schema> = {};
  const resolving: string[] = [];

  const env: TypeEnv = {
    lookupType(name: string): Schema | undefined {
      if (name in eager) return eager[name];
      if (name in memo) return memo[name];
      if (name in exprLocals) {
        if (resolving.includes(name)) {
          const cycle = [...resolving.slice(resolving.indexOf(name)), name].join(" -> ");
          report(ctx, `Circular local type dependency: ${cycle}`);
          return (memo[name] = true);
        }
        resolving.push(name);
        try {
          const s = synth(exprLocals[name]!, { ...ctx, env, path: [name] });
          return (memo[name] = s);
        } finally {
          resolving.pop();
        }
      }
      return parent?.lookupType(name);
    },
  };

  return env;
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

// Project the type of `target[key]` out of the target's schema. Handles the
// common static cases (object property by literal string key, array/tuple
// element by literal number key, static folded paths); anything dynamic or
// out-of-fragment degrades to `any`.
function projectField(target: Schema, key: JSONType, ctx: CheckContext): Schema {
  let t = target;
  while (classifySchema(t) === SchemaKind.Ref) t = resolveRef(t, ctx.defs);
  if (t === true) return true;

  if (typeof key === "string") {
    if (classifySchema(t) !== SchemaKind.Object) return true;
    const o = asObject(t);
    const props = properties(o);
    if (key in props) return props[key]!;
    const mode = apMode(o);
    if (mode.kind === "map") return mode.schema;
    if (mode.kind === "open") return true;
    // Closed object, missing key: the evaluator yields null at runtime.
    return { type: "null" };
  }

  if (typeof key === "number") {
    const k = classifySchema(t);
    if (k === SchemaKind.Array) return itemsSchema(asObject(t));
    if (k === SchemaKind.Tuple) {
      const o = asObject(t);
      const pi = prefixItems(o);
      if (key >= 0 && key < pi.length) return pi[key]!;
      return tupleRest(o) ?? { type: "null" };
    }
    return true;
  }

  if (Array.isArray(key)) {
    let cur = target;
    for (const seg of key) cur = projectField(cur, seg, ctx);
    return cur;
  }

  return true; // dynamic key
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
  if (i < sig.params.length) return sig.params[i]!;
  return sig.rest ?? null;
}

function checkArity(sig: Sig, argc: number, ctx: CheckContext): void {
  const min = sig.params.length;
  if (sig.rest === undefined) {
    if (argc !== min) report(ctx, `Expected ${min} argument(s), got ${argc}.`);
  } else if (argc < min) {
    report(ctx, `Expected at least ${min} argument(s), got ${argc}.`);
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
      const t = ctx.env.lookupType(name);
      // A miss is not necessarily an error: bare builtin/registry names resolve
      // as function values (§P4). Until the builtin layer lands, degrade to any.
      return t ?? true;
    }

    case "ref": {
      const fn = (expr as { $fn: JSONType }).$fn;
      if (typeof fn === "string") return ctx.env.lookupType(fn) ?? true;
      return synth(fn, ctx);
    }

    case "body":
      // A function value. Its type is its declared `$fnType`; unannotated
      // bodies (lambdas) can only be typed contextually (later milestone).
      return bodyFnTypeSchema(expr as Record<string, JSONType>);

    case "call": {
      const call = expr as { $call: JSONType; $args: JSONType[] };
      const args = Array.isArray(call.$args) ? call.$args : [];
      // A bare builtin name that no local/module binding shadows dispatches to
      // the polymorphic builtin layer (§5.3); user bindings still win.
      if (typeof call.$call === "string" && ctx.builtins && call.$call in ctx.builtins) {
        if (ctx.env.lookupType(call.$call) === undefined) {
          return synthBuiltinCall(ctx.builtins[call.$call]!, args, ctx);
        }
      }
      const sig = resolveCalleeSig(call.$call, ctx);
      if (sig === null) {
        // Unknown callee: still walk args to surface nested errors.
        args.forEach((a, i) => synth(a, at(ctx, `$args[${i}]`)));
        return true;
      }
      checkArity(sig, args.length, ctx);
      args.forEach((a, i) => {
        const param = paramAt(sig, i);
        if (param === null) synth(a, at(ctx, `$args[${i}]`));
        else check(a, param, at(ctx, `$args[${i}]`));
      });
      return sig.returns;
    }

    case "if": {
      const c = expr as { $if: JSONType; $then: JSONType; $else: JSONType };
      synth(c.$if, at(ctx, "$if"));
      // The guard narrows its subject in the matching arm (§5.5).
      const thenCtx = withNarrowings(ctx, factsFromCondition(c.$if, true, ctx));
      const elseCtx = withNarrowings(ctx, factsFromCondition(c.$if, false, ctx));
      return unionOf([synth(c.$then, at(thenCtx, "$then")), synth(c.$else, at(elseCtx, "$else"))]);
    }

    case "cond": {
      const c = expr as { $cond: [JSONType, JSONType][]; $else?: JSONType };
      const arms: Schema[] = [];
      // A `$cond` arm is reached only when every earlier condition was false, so
      // it accumulates their negated facts (dominating guards) plus its own
      // positive fact. `$else` inherits all conditions negated.
      let acc = ctx;
      c.$cond.forEach(([cond, result], i) => {
        synth(cond, at(acc, `$cond[${i}][0]`));
        const armCtx = withNarrowings(acc, factsFromCondition(cond, true, acc));
        arms.push(synth(result, at(armCtx, `$cond[${i}][1]`)));
        acc = withNarrowings(acc, factsFromCondition(cond, false, acc));
      });
      if ("$else" in c) arms.push(synth(c.$else!, at(acc, "$else")));
      return unionOf(arms);
    }

    case "match": {
      const m = expr as { $match: JSONType; $cases: [JSONType, JSONType][]; $else: JSONType };
      synth(m.$match, at(ctx, "$match"));
      // Narrow a bare-var subject per case: a literal case pins it to that
      // literal; `$else` sees the subject with every matched literal excluded.
      const subject = asVarName(m.$match);
      const matched: JSONType[] = [];
      const arms: Schema[] = [];
      m.$cases.forEach(([caseVal, result], i) => {
        let armCtx = ctx;
        const lit = litOf(caseVal);
        if (subject !== null && lit !== null) {
          const cur = currentType(subject, ctx);
          if (cur !== undefined) {
            armCtx = withNarrowings(ctx, { [subject]: restrictToLiteral(cur, lit.v, ctx.defs) });
            matched.push(lit.v);
          }
        }
        arms.push(synth(result, at(armCtx, `$cases[${i}][1]`)));
      });
      let elseCtx = ctx;
      if (subject !== null && matched.length > 0) {
        const cur = currentType(subject, ctx);
        if (cur !== undefined) {
          const excluded = matched.reduce((s, lit) => excludeLiteral(s, lit, ctx.defs), cur);
          elseCtx = withNarrowings(ctx, { [subject]: excluded });
        }
      }
      arms.push(synth(m.$else, at(elseCtx, "$else")));
      return unionOf(arms);
    }

    case "and": {
      const exprs = (expr as { $and: JSONType[] }).$and;
      return unionOf(exprs.map((e, i) => synth(e, at(ctx, `$and[${i}]`))));
    }

    case "or": {
      const exprs = (expr as { $or: JSONType[] }).$or;
      return unionOf(exprs.map((e, i) => synth(e, at(ctx, `$or[${i}]`))));
    }

    case "get": {
      const g = expr as { $get: JSONType; $from: JSONType };
      const target = synth(g.$from, at(ctx, "$from"));
      // Only literal keys project statically; dynamic keys degrade to any.
      const key = nodeKind(g.$get) === "scalar" || Array.isArray(g.$get) ? g.$get : undefined;
      if (key === undefined) {
        synth(g.$get, at(ctx, "$get"));
        return true;
      }
      return projectField(target, key, ctx);
    }

    case "raw":
      return synthData((expr as { $raw: JSONType }).$raw);
  }
}

// Break a schema into the arms a guard could narrow it down to: union arms
// (recursively, resolving `$ref`s), else the schema itself. Enums/consts stay
// whole — every literal already fits or fails a `sup` together.
function decomposeArms(s: Schema, defs: Defs): Schema[] {
  let t = s;
  while (classifySchema(t) === SchemaKind.Ref) t = resolveRef(t, defs);
  const arms = unionArms(t);
  if (arms) return arms.flatMap((a) => decomposeArms(a, defs));
  return [t];
}

// Is a failed `actual ⊆ expected` check *narrowable* rather than a hard error?
// True when the two types overlap — some arm of `actual` already fits
// `expected` — so a guard (or an explicit assertion) could make the value pass.
// Such mismatches are the §5.5 wall: without flow narrowing we can't prove them
// safe statically, so we downgrade them to runtime-checked warnings (§6) rather
// than emit a false positive. Disjoint mismatches (no arm fits) stay errors.
function narrowableMismatch(actual: Schema, expected: Schema, defs: Defs): boolean {
  return decomposeArms(actual, defs).some((arm) => isSubschema(arm, expected, defs));
}

// Report an `actual ⊄ expected` mismatch, choosing the severity per §5.5.
function reportMismatch(ctx: CheckContext, actual: Schema, expected: Schema): void {
  const severity: Severity = narrowableMismatch(actual, expected, ctx.defs) ? "warning" : "error";
  report(ctx, `${describe(actual)} is not assignable to ${describe(expected)}.`, {
    expected,
    actual,
    severity,
  });
}

// Verify an expression against an expected schema, reporting on mismatch.
function check(expr: JSONType, expected: Schema, ctx: CheckContext): void {
  // Un-annotated inline lambdas need contextual typing (later milestone); we
  // can't yet check their bodies against `expected`, so defer silently rather
  // than emit a spurious `any ⊄ (fn)` diagnostic.
  if (nodeKind(expr) === "body" && sigOf(expr as Record<string, JSONType>) === null) return;

  const actual = synth(expr, ctx);
  if (!isSubschema(actual, expected, ctx.defs)) reportMismatch(ctx, actual, expected);
}

function describe(schema: Schema): string {
  return JSON.stringify(schema);
}

export { buildTypeScope, synth, paramAt, checkArity, reportMismatch, check };
