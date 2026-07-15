// The polymorphic layer. Builtin signatures live in a language-agnostic table
// (`spec/builtins.json`, see docs/builtin-signatures.md) so all implementations
// share one source of truth and don't drift. That table speaks a small
// *builtin-only* dialect on top of the user-facing schema fragment:
//
//   * type variables — `{ "$tvar": "T" }` — instantiated per call site;
//   * overload sets — a builtin maps to an *array* of signatures, tried in
//     order (covers `add`'s integer-preservation and array/string overloads);
//   * variadic `rest` — reused from the `$fnType` shape;
//   * an escape hatch — `{ "rule": "name" }` — for builtins no data template
//     can capture (`pipe`, `apply`, effects), which each impl handles itself.
//
// The table is pure data; the code below is the (per-impl) engine that reads
// it: choose an overload, infer type variables from the concrete argument
// schemas, push the instantiated parameter types into inline-lambda arguments
// (contextual typing, §4.3), and instantiate the return.

import type { JSONType } from "../types";
import type { TVarNode, Bindings, BuiltinSig, BuiltinEntry } from "./builtin-types";
import { buildTypeScope, checkArity, paramAt, reportMismatch, synth } from "./checker";
import { at, type CheckContext, isBody, report, reportDegradation, sigOf } from "./context";
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
  mergeSchemas,
  collectSchemaRefs,
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
      // to `any`.
      for (const [key, cs] of Object.entries(cp)) {
        if (!(key in tp) && !unifyTemplateInto(tm.schema, cs, bindings, ctx)) return false;
      }
      if (cm.kind === "map" && !unifyTemplateInto(tm.schema, cm.schema, bindings, ctx))
        return false;
      if (cm.kind === "open" && !unifyTemplateInto(tm.schema, true, bindings, ctx)) return false;
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
// builtin demands, returning its synthesized body type. Reuses the term-scope
// machinery by stamping a synthetic `$sig` onto the lambda body.
function inferLambdaReturn(body: JSONType, expectedFn: Schema, ctx: CheckContext): Schema {
  const shape = fnShape(asObject(expectedFn));
  // Contextual typing supplies the *parameter* types (inline lambdas usually
  // omit them), but a lambda that declares its own `-> type` should still have
  // its body checked against that annotation. Capture it before it's replaced.
  const declaredReturn = sigOf(body as Record<string, JSONType>)?.returns;
  const withSig: Record<string, JSONType> = {
    ...(body as Record<string, JSONType>),
    $sig: {
      params: shape.params,
      ...(shape.rest !== undefined ? { rest: shape.rest } : {}),
      returns: shape.returns,
    },
  };
  const { env, guards } = buildTypeScope(withSig, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env, guards, path: [...ctx.path, "$return"] };
  const ret = synth((body as Record<string, JSONType>).$return!, bctx);
  if (declaredReturn !== undefined && !isSubschema(ret, declaredReturn, ctx.defs)) {
    reportMismatch(bctx, ret, declaredReturn);
  }
  return ret;
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
    if (isBody(argExprs[i]!)) continue; // lambda: defer
    concrete.push({ param, schema: synth(argExprs[i]!, silent) });
  }

  for (const arg of concrete) {
    if (!unifyTemplate(arg.param, arg.schema, bindings, ctx)) return null;
  }
  for (const arg of concrete) {
    if (!isSubschema(arg.schema, instantiate(arg.param, bindings), ctx.defs)) return null;
  }

  return bindings;
}

// Real pass over a chosen overload: emit diagnostics, type inline lambdas with
// the inferred type variables, and return the instantiated result schema.
function applyOverload(sig: BuiltinSig, argExprs: JSONType[], ctx: CheckContext): Schema {
  const arityOk = checkArity(sig, argExprs.length, ctx);
  const bindings: Bindings = {};
  const lambdas: number[] = [];
  const concrete: { param: Schema; schema: Schema; ctx: CheckContext }[] = [];

  // Pass 1 — synthesize every concrete arg without validating against bindings
  // that later arguments may still widen.
  for (let i = 0; i < argExprs.length; i++) {
    const param = paramAt(sig, i);
    const actx = at(ctx, `$args[${i}]`);
    if (param === null) {
      synth(argExprs[i]!, actx); // surplus arg (no param): still walk for errors
      continue;
    }
    if (isBody(argExprs[i]!)) {
      lambdas.push(i);
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
    if (!isSubschema(arg.schema, inst, ctx.defs)) reportMismatch(arg.ctx, arg.schema, inst);
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
    if (mentionsTVar(shape.returns)) {
      if (!unifyTemplate(shape.returns, ret, bindings, ctx)) {
        reportMismatch(at(actx, "$return"), ret, instantiate(shape.returns, bindings));
      }
    } else {
      const inst = instantiate(shape.returns, bindings);
      if (!isSubschema(ret, inst, ctx.defs)) reportMismatch(at(actx, "$return"), ret, inst);
    }
  }

  return instantiate(sig.returns, bindings);
}

// The result floor for the effect constructors: an opaque task node, whose
// runtime shape is a tagged record `{ "@task": string, ... }` (see `task.ts`).
// Referenced by name (`Task`, defined in `spec/builtins.json`'s `$defs`) rather
// than inlined, so it renders as `Task` *and* so a `-> Task` / `-> any`
// annotation can satisfy it without the `$ref`-to-top work (a `$ref` result
// resolves through subsumption; a bare `true` short-circuits before it can).
const TASK_FLOOR: Schema = { $ref: "#/$defs/Task" };

// Loose data floors for the `{ rule }` escape hatches (`pipe`/`apply`/effects).
// A rule has no agnostic template, but leaving it fully inert means no arity or
// shape checking and a bare-`any` result. Each floor pins the fixed arity, the
// result type, and (optionally) the shape of individual argument positions —
// just enough that a wrong-arity/wrong-shape call like `pipe(5, f)` is caught
// and effectful functions can carry a `Task` return. A per-impl code rule can
// still layer precision on top later.
type RuleFloor = { arity: number; returns: Schema; shapes?: Record<number, Schema> };

const RULE_FLOORS: Record<string, RuleFloor> = {
  pipe: { arity: 2, returns: true, shapes: { 0: { type: "array" } } },
  apply: { arity: 2, returns: true, shapes: { 1: { type: "array" } } },
  perform: {
    arity: 2,
    returns: TASK_FLOOR,
    shapes: { 0: { type: "string" }, 1: { type: "array" } },
  },
  pure: { arity: 1, returns: TASK_FLOOR },
  bind: { arity: 2, returns: TASK_FLOOR },
  raise: { arity: 1, returns: TASK_FLOOR },
};

// Apply an escape-hatch rule's floor: walk every arg for nested errors, check
// arity, then shape-check the pinned positions. An `any`-typed argument is
// exempt from shape checks — a strict `any ⊄ array` would hard-error on the
// many dynamically typed values that legitimately reach these builtins, so
// leniency here mirrors what an untyped escape hatch used to allow. Shape
// checks are skipped when arity is already wrong (one mistake, one diagnostic).
function synthRule(rule: string, argExprs: JSONType[], ctx: CheckContext): Schema {
  if (rule === "handle") return synthHandle(argExprs, ctx);

  const argTypes = argExprs.map((a, i) => synth(a, at(ctx, `$args[${i}]`)));
  const floor = RULE_FLOORS[rule];
  if (floor === undefined) {
    reportDegradation(ctx, `builtin rule "${rule}" is unsupported`);
    return true;
  }
  const aritySig = {
    params: Array.from({ length: floor.arity }, () => true as Schema),
    returns: true,
  };
  const arityOk = checkArity(aritySig, argExprs.length, ctx);
  if (arityOk && floor.shapes) {
    for (const [pos, expected] of Object.entries(floor.shapes)) {
      const i = Number(pos);
      const actual = argTypes[i];
      if (actual === undefined || actual === true) continue;
      if (!isSubschema(actual, expected, ctx.defs)) {
        reportMismatch(at(ctx, `$args[${i}]`), actual, expected);
      }
    }
  }
  if (floor.returns === true) {
    reportDegradation(ctx, `builtin rule "${rule}" has no precise return type`);
  }
  return floor.returns;
}

// `handle(task, handlers)` is deliberately partial and imprecise. The
// three-argument form carries a raw schema contract and is total at runtime, so
// its immediate result type is exactly that schema.
function synthHandle(argExprs: JSONType[], ctx: CheckContext): Schema {
  for (let i = 0; i < Math.min(argExprs.length, 2); i++) {
    synth(argExprs[i]!, at(ctx, `$args[${i}]`));
  }

  if (argExprs.length !== 2 && argExprs.length !== 3) {
    for (let i = 2; i < argExprs.length; i++) synth(argExprs[i]!, at(ctx, `$args[${i}]`));
    report(ctx, `Expected 2 or 3 arguments, got ${argExprs.length}.`);
    return true;
  }

  if (argExprs.length === 2) {
    reportDegradation(ctx, 'builtin rule "handle" has no precise return type');
    return true;
  }

  const annotationExpr = argExprs[2]!;
  if (
    !isSchemaObject(annotationExpr) ||
    Object.keys(annotationExpr).length !== 1 ||
    !("$raw" in annotationExpr)
  ) {
    report(at(ctx, "$args[2]"), "annotated handle requires a raw result-type schema");
    return true;
  }

  const schema = annotationExpr.$raw!;
  if (!isTractableHandleSchema(schema)) {
    report(
      at(at(ctx, "$args[2]"), "$raw"),
      "handle result annotation is outside the tractable type fragment",
    );
    return true;
  }

  const refs = new Set<string>();
  collectSchemaRefs(schema, refs);
  for (const name of refs) {
    if (!(name in ctx.defs)) {
      report(at(at(ctx, "$args[2]"), "$raw"), `reference to undefined type "${name}"`);
    }
  }
  return schema;
}

function isLiteralSchemaValue(value: JSONType): boolean {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

// Validate the same recursive schema fragment the shorthand type parser emits.
// This protects hand-authored canonical JSON; shorthand input is valid by
// construction.
function isTractableHandleSchema(schema: Schema): boolean {
  switch (classifySchema(schema)) {
    case SchemaKind.Any:
    case SchemaKind.Never:
      return true;
    case SchemaKind.Ref:
      return typeof asObject(schema).$ref === "string";
    case SchemaKind.Const:
      return isLiteralSchemaValue(asObject(schema).const!);
    case SchemaKind.Enum: {
      const values = asObject(schema).enum;
      return Array.isArray(values) && values.every(isLiteralSchemaValue);
    }
    case SchemaKind.Union: {
      const arms = unionArms(schema);
      return arms !== null && arms.every(isTractableHandleSchema);
    }
    case SchemaKind.Primitive:
      return ["null", "boolean", "number", "integer", "string"].includes(
        String(asObject(schema).type),
      );
    case SchemaKind.Array:
      return isTractableHandleSchema(itemsSchema(asObject(schema)));
    case SchemaKind.Tuple: {
      const object = asObject(schema);
      const rest = tupleRest(object);
      return (
        prefixItems(object).every(isTractableHandleSchema) &&
        (rest === null || isTractableHandleSchema(rest))
      );
    }
    case SchemaKind.Object: {
      const object = asObject(schema);
      const mode = apMode(object);
      return (
        Object.values(properties(object)).every(isTractableHandleSchema) &&
        (mode.kind !== "map" || isTractableHandleSchema(mode.schema))
      );
    }
    case SchemaKind.FnType: {
      if (!isSchemaObject(asObject(schema).$fnType)) return false;
      const shape = fnShape(asObject(schema));
      return (
        shape.params.every(isTractableHandleSchema) &&
        (shape.rest === undefined || isTractableHandleSchema(shape.rest)) &&
        isTractableHandleSchema(shape.returns)
      );
    }
    case SchemaKind.Opaque:
      return false;
  }
}

// `merge` needs a genuine schema computation that the shared substitution
// templates cannot express: structural object spread. After the ordinary
// overload pass (which still emits arg/arity diagnostics), recompute its return
// from silently synthesized operands.
const CODE_RETURNS: Record<string, (argExprs: JSONType[], ctx: CheckContext) => Schema> = {
  merge: (argExprs, ctx) => {
    if (argExprs.length !== 2) return { type: "object" };
    const silent: CheckContext = { ...ctx, diagnostics: [] };
    const a = synth(argExprs[0]!, silent);
    const b = synth(argExprs[1]!, silent);
    return mergeSchemas(a, b, ctx.defs);
  },
};

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

// Dispatch a builtin call by its table entry.
function synthBuiltinCall(
  name: string,
  entry: BuiltinEntry,
  argExprs: JSONType[],
  ctx: CheckContext,
): Schema {
  if (!Array.isArray(entry)) return synthRule(entry.rule, argExprs, ctx); // `{ rule }` escape hatch
  const chosen = entry.find((ov) => tryBindOverload(ov, argExprs, ctx) !== null);
  // No arm fits and there's more than one: report the whole overload set rather
  // than blaming (and pinpointing against) just the first arm. A single-arm
  // builtin still falls through to `applyOverload`, whose per-argument, arity,
  // and return diagnostics are already precise.
  if (chosen === undefined && entry.length > 1) {
    return reportNoOverload(name, entry, argExprs, ctx);
  }
  const result = applyOverload(chosen ?? entry[0]!, argExprs, ctx);
  const code = CODE_RETURNS[name];
  return code ? code(argExprs, ctx) : result;
}

export { synthBuiltinCall };
