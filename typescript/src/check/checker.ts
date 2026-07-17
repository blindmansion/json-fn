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
import { asPath, litOf, nodeKind } from "./ast";
import {
  at,
  bindingKeys,
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
  deepEqual,
  fixedParamSchemas,
  fnShape,
  isClosedMissingKey,
  isSchemaObject,
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
  const sigParams = sig === null ? [] : fixedParamSchemas(sig);
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
  reportUntypedBodies = true,
  injectedSig?: Sig,
): { env: TypeEnv; guards: Record<string, JSONType> } {
  const eager: Record<string, Schema> = {};
  const exprLocals: Record<string, JSONType> = {};

  const sig = injectedSig ?? sigOf(body);
  const params = Array.isArray(body.$params) ? (body.$params as JSONType[]) : [];
  bindParams(params, sig, eager);

  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) {
      if (reportUntypedBodies && sigOf(val) === null) {
        reportDegradation(at(ctx, key), `function binding "${key}" has no declared signature`);
      }
      eager[key] = bodyFnTypeSchema(val); // sibling function: eager `$fnType`
    } else {
      exprLocals[key] = val; // un-annotated local: typed lazily below
    }
  }

  // Lazy locals double as named boolean guards (§2.3); outer guards remain in
  // scope, with siblings shadowing them.
  const guards: Record<string, JSONType> = { ...ctx.guards, ...exprLocals };
  // Facts that dominate creation of this lexical scope also dominate every
  // evaluation of its lazy locals. A forcing site can add facts, but crossing
  // an IIFE/callback boundary must not erase the facts under which the scope
  // itself was created.
  const creationNarrowings = ctx.narrowings ?? {};

  // Two-tier cache: `memo` is the type when no creation/forcing facts relevant
  // to the local are active; `narrowedMemo[name][key]` holds a re-synth under a
  // specific set of *relevant* merged facts (§2.2c).
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
  const min = fixedParamSchemas(sig).length;
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
        reportDegradation(ctx, "the function value has no declared signature");
      }
      return bodyFnTypeSchema(body);
    }

    case "call": {
      const call = expr as { $call: JSONType; $args: JSONType[] };
      const args = Array.isArray(call.$args) ? call.$args : [];
      // An inline *un-annotated* body callee is an IIFE — the zero-arg wrapper
      // the shorthand emits for a standalone `expr where { … }` and for a
      // `do { … }` block with leading pure bindings. It carries no `$sig`, so
      // `resolveCalleeSig` can't recover a function type; synthesize the body's
      // `$return` directly instead of degrading the whole call to `any`.
      const callee = call.$call;
      if (isBody(callee) && sigOf(callee) === null) {
        const bctx = iifeBodyContext(callee, args, ctx);
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

    case "cast": {
      const inner = synth((expr as { $cast: JSONType }).$cast, at(ctx, "$cast"));
      return removeType(inner, "null", ctx.defs);
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
// discharge it with the `x!` assertion and accept a runtime-checked cast.
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
// in checked position we stamp the expected signature onto a copy of the body so
// its params bind to the expected param types, then reuse `checkBody` to verify
// its `$return` against the expected return type (recursing structurally) and
// recurse into its nested locals — exactly as an annotated body is checked. This
// is what finally lets a bare capability-record lambda (`() => task`) check
// against a field's declared `() -> Task` instead of erasing to `any` and then
// dumping a spurious `any ⊄ (fn)`. Arity is strict (mirroring `fnSubsumes`,
// modulo rest); a mismatch is reported here rather than deferred, since the
// un-annotated lambda has no synthesizable type for the whole-schema fallback.
function checkLambda(
  body: Record<string, JSONType>,
  exp: Record<string, JSONType>,
  ctx: CheckContext,
): void {
  const shape = fnShape(exp);
  const shapeParams = fixedParamSchemas(shape);
  const params = Array.isArray(body.$params) ? (body.$params as JSONType[]) : [];
  let fixed = 0;
  let hasRest = false;
  for (const p of params) {
    if (typeof p === "string" && p.startsWith("...")) {
      hasRest = true;
      break;
    }
    fixed++;
  }
  if (fixed !== shapeParams.length || hasRest !== (shape.rest !== undefined)) {
    const actual: Schema = {
      $fnType: {
        required: Array.from({ length: fixed }, () => true as Schema),
        optional: [],
        ...(hasRest ? { rest: true } : {}),
        returns: true,
      },
    };
    reportMismatch(ctx, actual, exp);
    return;
  }
  const withSig: Record<string, JSONType> = {
    ...body,
    $sig: {
      required: shape.required,
      optional: shape.optional,
      ...(shape.rest !== undefined ? { rest: shape.rest } : {}),
      returns: shape.returns,
    },
  };
  checkBody(withSig, ctx);
}

// Type the body of an *un-annotated inline body callee* — an IIFE, e.g. the
// zero-arg wrapper the shorthand emits for a standalone `expr where { … }` or a
// `do { … }` block with leading pure bindings. Such a body has no `$sig`, so
// `bodyFnTypeSchema` erases it to `any` and `resolveCalleeSig` can't recover a
// function type; the call would otherwise degrade the whole expression to `any`
// and drop the body's real return type. Instead bind the params to the
// synthesized argument types, report any arity mismatch, and recurse into nested
// function locals (so their bodies are still checked) — then hand back the body
// context for the caller to synth/check the body's `$return` under. Mirrors
// `checkBody`, minus the declared-return check (an IIFE declares none).
function iifeBodyContext(
  body: Record<string, JSONType>,
  args: JSONType[],
  ctx: CheckContext,
): CheckContext {
  const params = Array.isArray(body.$params) ? (body.$params as JSONType[]) : [];
  const restIdx = params.findIndex((p) => typeof p === "string" && p.startsWith("..."));
  const hasRest = restIdx !== -1;
  const fixed = hasRest ? restIdx : params.length;

  // Arguments are outer expressions, synthesized in the caller's scope; their
  // types become the (otherwise un-annotated) fixed params' types.
  const argTypes = args.map((a, i) => synth(a, at(ctx, `$args[${i}]`)));
  if (!hasRest && args.length !== params.length) {
    report(ctx, `Expected ${params.length} argument(s), got ${args.length}.`);
  } else if (hasRest && args.length < fixed) {
    report(ctx, `Expected at least ${fixed} argument(s), got ${args.length}.`);
  }

  const withSig: Record<string, JSONType> = {
    ...body,
    $sig: { required: argTypes.slice(0, fixed), optional: [], returns: true },
  };
  const { env, guards } = buildTypeScope(withSig, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env, guards };
  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) checkBody(val, at(bctx, key));
  }
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
// `synth` cases thread reach each arm in checked position too. An IIFE (inline
// un-annotated body callee — a `do { … }` block or `expr where { … }`) has its
// body's `$return` checked against the expected type (see `iifeBodyContext`).
function check(expr: JSONType, expected: Schema, ctx: CheckContext): void {
  const kind = nodeKind(expr);

  // Un-annotated inline lambda: contextually type it against an expected
  // function type (see `checkLambda`). A non-fn-type expected (`any`, or a
  // non-function) can't supply param types, so defer silently rather than emit
  // a spurious `any ⊄ …` for a value whose own type is un-synthesizable.
  if (kind === "body" && sigOf(expr as Record<string, JSONType>) === null) {
    const exp = resolveDeep(expected, ctx.defs);
    if (classifySchema(exp) === SchemaKind.FnType) {
      checkLambda(expr as Record<string, JSONType>, asObject(exp), ctx);
    }
    return;
  }

  // An IIFE (inline un-annotated body callee, e.g. a standalone
  // `expr where { … }` or a `do { … }` block) in checked position: push the
  // expected type into the body's `$return` so a mismatch pinpoints there,
  // mirroring the synth case rather than synthesizing-then-subsuming the call.
  if (kind === "call") {
    const callee = (expr as { $call: JSONType }).$call;
    if (isBody(callee) && sigOf(callee) === null) {
      const args = (expr as { $args?: JSONType[] }).$args;
      const bctx = iifeBodyContext(callee, Array.isArray(args) ? args : [], ctx);
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

// Check a function body against its declared signature: build its scope, verify
// `$return` against the declared return type, then recurse into nested function
// locals. Shared by the module entry (`checkModule`) and by `synth`'s body case,
// so a declared `-> type` is enforced wherever a typed function literal appears
// — a module binding, a value in `$return`/argument position, or a standalone
// expression checked via `checkExpr` (`--expr`).
function checkBody(body: Record<string, JSONType>, ctx: CheckContext, injectedSig?: Sig): void {
  if (injectedSig !== undefined) checkInjectedBodyArity(body, injectedSig, ctx);
  const sig = injectedSig ?? sigOf(body);
  const { env, guards } = buildTypeScope(body, ctx.env, ctx, true, injectedSig);
  const bctx: CheckContext = { ...ctx, env, guards };
  check(body.$return!, sig?.returns ?? true, at(bctx, "$return"));
  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) checkBody(val, at(bctx, key));
  }
}

// A contextually supplied signature owns the body's callable shape as well as
// its parameter and return types. In particular, environment entry injection
// must not silently accept a guest body with fewer/more parameters than the
// operator contract (the removed entry-specific reconciliation pass enforced
// this before entry checking moved onto the normal body path).
function checkInjectedBodyArity(body: Record<string, JSONType>, sig: Sig, ctx: CheckContext): void {
  const params = Array.isArray(body.$params) ? (body.$params as JSONType[]) : [];
  const restIndex = params.findIndex((p) => typeof p === "string" && p.startsWith("..."));
  const hasRest = restIndex !== -1;
  const fixed = hasRest ? restIndex : params.length;
  const expectsRest = sig.rest !== undefined;
  const expectedFixed = fixedParamSchemas(sig).length;
  if (fixed === expectedFixed && hasRest === expectsRest) return;

  const expected = `${expectedFixed} fixed parameter(s)${expectsRest ? " and a rest parameter" : ""}`;
  const actual = `${fixed} fixed parameter(s)${hasRest ? " and a rest parameter" : ""}`;
  report(at(ctx, "$params"), `Contextual signature expects ${expected}; body declares ${actual}.`);
}

export { buildTypeScope, synth, paramAt, checkArity, reportMismatch, check, checkBody };
