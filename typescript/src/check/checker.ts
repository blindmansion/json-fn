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
import { asPath, asVarName, litOf, nodeKind } from "./ast";
import {
  at,
  bindingKeys,
  bodyFnTypeSchema,
  isBody,
  report,
  sigOf,
  stableStringify,
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
  restrictToTruthy,
  restrictToFalsy,
  caseUniverse,
} from "./narrowing";
import {
  apMode,
  asObject,
  classifySchema,
  deepEqual,
  fnShape,
  isSchemaObject,
  keyCouldBe,
  projectComputed,
  projectField,
  properties,
  resolveDeep,
  resolveRef,
  SchemaKind,
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

// Collect every `$var` name syntactically referenced by an expression. Used to
// over-approximate a lazy local's free variables (§5.5 M2 §2.2b): we descend
// into everything except `$raw` payloads (unevaluated data), *including* nested
// lambda bodies — ignoring their shadowing is a sound over-approximation (a
// superset only ever triggers a harmless extra re-synth, never a stale type).
function collectVars(expr: JSONType, acc: Set<string>): void {
  if (expr === null || typeof expr !== "object") return;
  if (Array.isArray(expr)) {
    for (const e of expr) collectVars(e, acc);
    return;
  }
  const o = expr as Record<string, JSONType>;
  if (typeof o.$var === "string") {
    acc.add(o.$var);
    return;
  }
  if ("$raw" in o) return;
  // A static access path (`move.from`) is itself a narrowable subject (§5.5 M3),
  // so record it alongside its root var — a local that reaches through it must
  // re-synth when that path is narrowed. Then descend as usual (the root var is
  // still collected from `$from`).
  if (nodeKind(o) === "get") {
    const p = asPath(o);
    if (p !== null) acc.add(p);
  }
  for (const val of Object.values(o)) collectVars(val, acc);
}

function buildTypeScope(
  body: Record<string, JSONType>,
  parent: TypeEnv | null,
  ctx: CheckContext,
): { env: TypeEnv; guards: Record<string, JSONType> } {
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

  // Lazy locals double as named boolean guards (§2.3); outer guards remain in
  // scope, with siblings shadowing them.
  const guards: Record<string, JSONType> = { ...ctx.guards, ...exprLocals };

  // Two-tier cache: `memo` is the un-narrowed type (the fast path, byte-for-byte
  // as before); `narrowedMemo[name][key]` holds a re-synth under a specific set
  // of *relevant* facts (§2.2c).
  const memo: Record<string, Schema> = {};
  const narrowedMemo: Record<string, Record<string, Schema>> = {};
  const freeVarsMemo: Record<string, Set<string>> = {};
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
      if (dv !== name && dv in exprLocals) for (const fv of freeVarsOf(dv)) result.add(fv);
    }
    return result;
  }

  // The subset of `narrowings` that could actually change this local's type.
  function relevantFacts(name: string, narrowings: Record<string, Schema>): Record<string, Schema> {
    const fv = freeVarsOf(name);
    const out: Record<string, Schema> = {};
    for (const k of Object.keys(narrowings)) if (fv.has(k)) out[k] = narrowings[k]!;
    return out;
  }

  // Synthesize a lazy local's type under the given facts (undefined ⇒ fast
  // path). Shares the `resolving` cycle guard across both paths.
  function resolveLocal(name: string, narrowings: Record<string, Schema> | undefined): Schema {
    if (resolving.includes(name)) {
      const cycle = [...resolving.slice(resolving.indexOf(name)), name].join(" -> ");
      report(ctx, `Circular local type dependency: ${cycle}`);
      return true;
    }
    resolving.push(name);
    try {
      return synth(exprLocals[name]!, { ...ctx, env, guards, path: [name], narrowings });
    } finally {
      resolving.pop();
    }
  }

  const env: TypeEnv = {
    lookupType(name: string, narrowings?: Record<string, Schema>): Schema | undefined {
      if (name in eager) return eager[name];
      if (!(name in exprLocals)) return parent?.lookupType(name, narrowings);

      // Gate: only facts this local depends on matter. With none, the plain
      // memo answers — the no-narrowing path stays exactly as before.
      const relevant =
        narrowings && Object.keys(narrowings).length > 0 ? relevantFacts(name, narrowings) : {};
      if (Object.keys(relevant).length === 0) {
        if (name in memo) return memo[name];
        return (memo[name] = resolveLocal(name, undefined));
      }

      const bucket = (narrowedMemo[name] ??= {});
      const key = stableStringify(relevant);
      if (key in bucket) return bucket[key]!;
      return (bucket[key] = resolveLocal(name, relevant));
    },
  };

  return { env, guards };
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
// positions demand an `integer`, object/map keys a `string`. A key that could
// still be the right category at runtime (an overlapping type like `number`,
// where flow could produce a valid integer) is the §5.5 runtime-checkable
// `warning`; a key that never can (a `string` index, a fractional literal) is a
// hard `error`. Non-container / union / `any` targets and `any`/`never` keys are
// left permissive — the projection already degrades those to `any`.
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
  const overlaps = keyCouldBe(keyType, cat, ctx.defs);
  report(ctx, `Index key must be ${cat === "integer" ? "an integer" : "a string"}.`, {
    severity: overlaps ? "warning" : "error",
    expected: probe,
    actual: keyType,
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
  if (i < sig.params.length) return sig.params[i]!;
  return sig.rest ?? null;
}

// Report an arity mismatch, returning whether the count was acceptable. Callers
// use the result to skip downstream, arity-dependent checks (e.g. contextual
// lambda typing) that would otherwise pile spurious diagnostics onto the real
// arity error.
function checkArity(sig: Sig, argc: number, ctx: CheckContext): boolean {
  const min = sig.params.length;
  if (sig.rest === undefined) {
    if (argc !== min) {
      report(ctx, `Expected ${min} argument(s), got ${argc}.`);
      return false;
    }
  } else if (argc < min) {
    report(ctx, `Expected at least ${min} argument(s), got ${argc}.`);
    return false;
  }
  return true;
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
      // A direct hit above; otherwise this may be an *indirect* narrowing — a
      // lazy local that references a narrowed var — so pass the active facts
      // down for re-synth under them (§5.5 M2).
      const t = ctx.env.lookupType(name, ctx.narrowings);
      // A miss is not necessarily an error: bare builtin/registry names resolve
      // as function values (§P4). Until the builtin layer lands, degrade to any.
      return t ?? true;
    }

    case "ref": {
      const fn = (expr as { $fn: JSONType }).$fn;
      if (typeof fn === "string") return ctx.env.lookupType(fn) ?? true;
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
      if (sigOf(body) !== null) checkBody(body, ctx);
      return bodyFnTypeSchema(body);
    }

    case "call": {
      const call = expr as { $call: JSONType; $args: JSONType[] };
      const args = Array.isArray(call.$args) ? call.$args : [];
      // A bare builtin name that no local/module binding shadows dispatches to
      // the polymorphic builtin layer (§5.3); user bindings still win. The
      // dispatcher is injected (see `CheckContext.synthBuiltinCall`) so this
      // core module never imports the builtin engine.
      if (
        typeof call.$call === "string" &&
        ctx.builtins &&
        ctx.synthBuiltinCall &&
        call.$call in ctx.builtins
      ) {
        if (ctx.env.lookupType(call.$call) === undefined) {
          return ctx.synthBuiltinCall(call.$call, ctx.builtins[call.$call]!, args, ctx);
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
      const m = expr as { $match: JSONType; $cases: [JSONType, JSONType][]; $else?: JSONType };
      const subjectType = synth(m.$match, at(ctx, "$match"));
      // The finite set of values the subject can take (an enum var, a union of
      // consts, or a `base.field` discriminant), or null when it isn't a finite
      // literal set. Drives the §5.6 exhaustiveness / dead-case lints below.
      const universe = caseUniverse(m.$match, subjectType, ctx);
      // Narrow a bare-var subject per case: a literal case pins it to that
      // literal; `$else` sees the subject with every matched literal excluded.
      const subject = asVarName(m.$match);
      const matched: JSONType[] = []; // narrowed literals (bare-var subject only)
      const caseLiterals: JSONType[] = []; // every literal case value (for lints)
      let allLiteral = true;
      const arms: Schema[] = [];
      m.$cases.forEach(([caseVal, result], i) => {
        const lit = litOf(caseVal);
        if (lit === null) allLiteral = false;
        else {
          caseLiterals.push(lit.v);
          // Dead case: a literal the subject's finite universe can't produce, so
          // it can never match. A lint (the runtime simply never takes it).
          if (universe !== null && !universe.some((u) => deepEqual(u, lit.v))) {
            report(
              at(ctx, `$cases[${i}][0]`),
              `Unreachable $match case: ${JSON.stringify(lit.v)} is not a possible value of the subject.`,
              { severity: "warning" },
            );
          }
        }
        let armCtx = ctx;
        if (subject !== null && lit !== null) {
          const cur = currentType(subject, ctx);
          if (cur !== undefined) {
            armCtx = withNarrowings(ctx, { [subject]: restrictToLiteral(cur, lit.v, ctx.defs) });
            matched.push(lit.v);
          }
        }
        arms.push(synth(result, at(armCtx, `$cases[${i}][1]`)));
      });

      if ("$else" in m) {
        let elseCtx = ctx;
        if (subject !== null && matched.length > 0) {
          const cur = currentType(subject, ctx);
          if (cur !== undefined) {
            const excluded = matched.reduce((s, lit) => excludeLiteral(s, lit, ctx.defs), cur);
            elseCtx = withNarrowings(ctx, { [subject]: excluded });
          }
        }
        arms.push(synth(m.$else!, at(elseCtx, "$else")));
      } else if (allLiteral && universe !== null) {
        // §5.6 exhaustiveness: no catch-all `$else`, yet the finite universe has
        // values no case covers — those inputs silently fall through. A lint
        // (the same tier as the M0 narrowable warnings), not a hard error.
        const uncovered = universe.filter((u) => !caseLiterals.some((l) => deepEqual(l, u)));
        if (uncovered.length > 0) {
          report(
            ctx,
            `Non-exhaustive $match: unhandled case(s) ${uncovered.map((u) => JSON.stringify(u)).join(", ")}.`,
            { severity: "warning" },
          );
        }
      }
      return unionOf(arms);
    }

    case "and":
      return shortCircuitType((expr as { $and: JSONType[] }).$and, true, ctx);

    case "or":
      return shortCircuitType((expr as { $or: JSONType[] }).$or, false, ctx);

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
      if (Array.isArray(g.$get)) return projectField(target, g.$get, ctx.defs);
      // A scalar literal key projects by value; still index-checked (e.g. to
      // reject `xs[2.5]`).
      if (nodeKind(g.$get) === "scalar") {
        checkIndexKey(target, synthData(g.$get), at(ctx, "$get"));
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

// Check a function body against its declared signature: build its scope, verify
// `$return` against the declared return type, then recurse into nested function
// locals. Shared by the module entry (`checkModule`) and by `synth`'s body case,
// so a declared `-> type` is enforced wherever a typed function literal appears
// — a module binding, a value in `$return`/argument position, or a standalone
// expression checked via `checkExpr` (`--expr`).
function checkBody(body: Record<string, JSONType>, ctx: CheckContext): void {
  const sig = sigOf(body);
  const { env, guards } = buildTypeScope(body, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env, guards };
  check(body.$return!, sig?.returns ?? true, at(bctx, "$return"));
  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) checkBody(val, at(bctx, key));
  }
}

export { buildTypeScope, synth, paramAt, checkArity, reportMismatch, check, checkBody };
