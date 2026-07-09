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
import { at, type CheckContext, isBody } from "./context";
import {
  type Schema,
  isSchemaObject,
  classifySchema,
  SchemaKind,
  resolveRef,
  itemsSchema,
  asObject,
  tupleRest,
  unionOf,
  prefixItems,
  fnShape,
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
    return unionOf(rest === null ? prefixItems(o) : [...prefixItems(o), rest]);
  }
  return null;
}

// Match a signature template against a concrete argument schema: bind type
// variables where the template has them, and verify compatibility where it
// doesn't. Returns false only on a definite concrete mismatch, which lets
// overload selection reject an arm.
function unifyTemplate(
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

  const tk = classifySchema(template);

  if (tk === SchemaKind.Array) {
    const elem = elementSchemaOf(concrete, ctx);
    if (elem === null) return concrete === true; // only `any` fits a non-array
    return unifyTemplate(itemsSchema(asObject(template)), elem, bindings, ctx);
  }

  if (tk === SchemaKind.FnType) {
    if (classifySchema(concrete) !== SchemaKind.FnType) return concrete === true;
    const a = fnShape(asObject(template));
    const b = fnShape(asObject(concrete));
    if (a.params.length !== b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) {
      if (!unifyTemplate(a.params[i]!, b.params[i]!, bindings, ctx)) return false;
    }
    return unifyTemplate(a.returns, b.returns, bindings, ctx);
  }

  // No type variables to bind here — a plain compatibility check.
  return isSubschema(concrete, instantiate(template, bindings), ctx.defs);
}

// Type an inline-lambda argument under the (instantiated) parameter types the
// builtin demands, returning its synthesized body type. Reuses the term-scope
// machinery by stamping a synthetic `$sig` onto the lambda body.
function inferLambdaReturn(body: JSONType, expectedFn: Schema, ctx: CheckContext): Schema {
  const shape = fnShape(asObject(expectedFn));
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
  return synth((body as Record<string, JSONType>).$return!, bctx);
}

// Trial: can this overload accept the arguments? Binds type variables from the
// concrete (non-lambda) args; lambdas are deferred to `applyOverload`. Returns
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
  for (let i = 0; i < argExprs.length; i++) {
    const param = paramAt(sig, i);
    if (param === null) return null;
    if (isBody(argExprs[i]!)) continue; // lambda: defer
    const argSchema = synth(argExprs[i]!, silent);
    if (!unifyTemplate(param, argSchema, bindings, ctx)) return null;
  }
  return bindings;
}

// Real pass over a chosen overload: emit diagnostics, type inline lambdas with
// the inferred type variables, and return the instantiated result schema.
function applyOverload(sig: BuiltinSig, argExprs: JSONType[], ctx: CheckContext): Schema {
  const arityOk = checkArity(sig, argExprs.length, ctx);
  const bindings: Bindings = {};
  const lambdas: number[] = [];

  // Pass 1 — concrete args bind the input type variables.
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
    const argSchema = synth(argExprs[i]!, actx);
    unifyTemplate(param, argSchema, bindings, ctx);
    const inst = instantiate(param, bindings);
    if (!isSubschema(argSchema, inst, ctx.defs)) reportMismatch(actx, argSchema, inst);
  }

  // Pass 2 — lambdas, now that input variables are known. Their returns bind
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
      unifyTemplate(shape.returns, ret, bindings, ctx);
    } else {
      const inst = instantiate(shape.returns, bindings);
      if (!isSubschema(ret, inst, ctx.defs)) reportMismatch(at(actx, "$return"), ret, inst);
    }
  }

  return instantiate(sig.returns, bindings);
}

// Dispatch a builtin call by its table entry.
function synthBuiltinCall(entry: BuiltinEntry, argExprs: JSONType[], ctx: CheckContext): Schema {
  if (!Array.isArray(entry)) {
    // `{ rule: ... }` escape hatch: no agnostic template. Walk args for nested
    // errors and yield `any` (a per-impl code rule may refine this later).
    argExprs.forEach((a, i) => synth(a, at(ctx, `$args[${i}]`)));
    return true;
  }
  const chosen = entry.find((ov) => tryBindOverload(ov, argExprs, ctx) !== null) ?? entry[0]!;
  return applyOverload(chosen, argExprs, ctx);
}

export { synthBuiltinCall };
