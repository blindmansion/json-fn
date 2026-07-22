// Guard-then-use is the dominant idiom in real code: a value typed `T | null`
// (or a wider union) is tested by a guard, then used on the branch where the
// guard rules out the bad arm. Without narrowing, the checker keeps the
// declared type inside the branch and a `string`-expecting use of a
// now-provably-`Piece` value fires a (downgraded) warning. M1 does *real*
// narrowing for the tractable case: the guarded subject is a bare `$var`
// (a param or an eagerly-bound name) and the fact holds within one
// `$if`/`$cond`/`$match` arm.
//
// Facts live on `ctx.narrowings` (see `CheckContext`) and are threaded into the
// child context of the arm they govern; sibling arms are unaffected. `synth`'s
// `"var"` case reads them. Narrowing is a *sound refinement* — a fact only ever
// shrinks a type — and any unrecognized guard form simply yields no fact
// (falling back to the M0 warning path), never a silent pass.

import type { JSONType } from "../types";
import { asPath, asVarName, litOf, nodeKind } from "./ast";
import { type CheckContext } from "./context";
import {
  type Schema,
  valueType,
  type Defs,
  resolveDeep,
  classifySchema,
  SchemaKind,
  asObject,
  literalValues,
  projectField,
  unionArms,
  unionOf,
  deepEqual,
  isSchemaObject,
} from "../schema/schema.ts";
import { isSubschema } from "./subsumption";
import { valueSatisfies } from "../schema/values.ts";

// The type a var has *right now*: its active narrowing if any, else its
// declared type from Γ. `undefined` when the name is unbound (can't narrow).
function currentType(name: string, ctx: CheckContext): Schema | undefined {
  return ctx.narrowings?.[name] ?? ctx.env.lookupType(name);
}

// The type an access-path expression has *right now* (§5.5 M3): the path's own
// active narrowing if any, else the declared type — a bare var from Γ, or a
// static `$get` chain projected out of its base's current type. `undefined`
// when the subject isn't a static path or its base is unbound.
function currentTypeOfExpr(node: JSONType, ctx: CheckContext): Schema | undefined {
  const path = asPath(node);
  if (path === null) return undefined;
  const narrowed = ctx.narrowings?.[path];
  if (narrowed !== undefined) return narrowed;

  const name = asVarName(node);
  if (name !== null) return ctx.env.lookupType(name);

  if (nodeKind(node) === "get") {
    const o = node as { $get: JSONType; $from: JSONType };
    const baseT = currentTypeOfExpr(o.$from, ctx);
    if (baseT === undefined) return undefined;
    if (typeof o.$get === "string" || Array.isArray(o.$get)) {
      return projectField(baseT, o.$get, ctx.defs);
    }
  }
  return undefined;
}

// A child context with extra narrowing facts merged in (later facts win). A
// no-op spread when there is nothing to add, so the un-narrowed path is
// untouched.
function withNarrowings(ctx: CheckContext, facts: Record<string, Schema>): CheckContext {
  if (Object.keys(facts).length === 0) return ctx;
  return { ...ctx, narrowings: { ...ctx.narrowings, ...facts } };
}

// The primitive value-type category a JSON value belongs to, matched against a
// type predicate's name.
function valueTypeMatches(v: JSONType, typeName: string): boolean {
  if (typeName === "number") return typeof v === "number";
  if (typeName === "integer") return typeof v === "number" && Number.isInteger(v);
  return valueType(v) === typeName;
}

// Rebuild an enum/const schema from a surviving literal set (empty ⇒ never).
function fromLiterals(vals: JSONType[]): Schema {
  if (vals.length === 0) return false;
  if (vals.length === 1) return { const: vals[0]! };
  return { enum: vals };
}

// Filter a finite schema without discarding constraints attached alongside its
// const/enum. Bare finite schemas retain the compact fact-map representation.
function filterFiniteSchema(
  s: Schema,
  keep: (value: JSONType) => boolean,
  replacementType?: string,
): Schema {
  const values = literalValues(s).filter(keep);
  if (values.length === 0) return false;

  const object = asObject(s);
  const kind = classifySchema(s);
  const literalKey = kind === SchemaKind.Const ? "const" : "enum";
  if (Object.keys(object).every((key) => key === literalKey)) return fromLiterals(values);

  const filtered: Record<string, JSONType> = { ...object };
  if (kind === SchemaKind.Enum) filtered.enum = values;
  if (replacementType !== undefined && object.type === "number") {
    filtered.type = replacementType;
  }
  return filtered;
}

// Meet with "value is of category `typeName`". This is a small, purpose-built
// intersection over the runtime categories recognized by TYPE_PREDICATES, not
// a general JSON Schema intersection.
function restrictToType(s: Schema, typeName: string, defs: Defs): Schema {
  const t = resolveDeep(s, defs);
  if (t === true) return { type: typeName };
  if (t === false) return false;

  const arms = unionArms(t);
  if (arms) return unionOf(arms.map((a) => restrictToType(a, typeName, defs)));

  switch (classifySchema(t)) {
    case SchemaKind.Const:
    case SchemaKind.Enum:
      return filterFiniteSchema(
        t,
        (value) => valueTypeMatches(value, typeName),
        typeName === "integer" ? "integer" : undefined,
      );
    case SchemaKind.Primitive: {
      const actual = asObject(t).type as string;
      if (actual === typeName || (typeName === "number" && actual === "integer")) return t;
      if (typeName === "integer" && actual === "number") {
        return { ...asObject(t), type: "integer" };
      }
      return false;
    }
    case SchemaKind.Array:
    case SchemaKind.Tuple:
      return typeName === "array" ? t : false;
    case SchemaKind.Object:
      return typeName === "object" ? t : false;
    default:
      return false;
  }
}

// Meet with "value is NOT of category `typeName`". Exact finite inhabitants
// are filtered; broad overlapping schemas stay unchanged when their remainder
// cannot be represented (notably `number - integer`).
function removeType(s: Schema, typeName: string, defs: Defs): Schema {
  const probe: Schema = { type: typeName };
  const t = resolveDeep(s, defs);
  if (t === true || t === false) return t;

  const arms = unionArms(t);
  if (arms) return unionOf(arms.map((a) => removeType(a, typeName, defs)));

  switch (classifySchema(t)) {
    case SchemaKind.Const:
    case SchemaKind.Enum:
      return filterFiniteSchema(t, (value) => !valueTypeMatches(value, typeName));
    default:
      return isSubschema(t, probe, defs) ? false : t;
  }
}

// Meet with `{const v}`: the literal itself when admissible, else never (dead
// branch — the guard can't hold for any value of the declared type).
function restrictToLiteral(s: Schema, v: JSONType, defs: Defs): Schema {
  return valueSatisfies(v, s, defs) ? { const: v } : false;
}

// Meet with "value ≠ v": enum/const membership surgery (a no-op for schemas
// with no finite literal set).
function excludeLiteral(s: Schema, v: JSONType, defs: Defs): Schema {
  const t = resolveDeep(s, defs);
  switch (classifySchema(t)) {
    case SchemaKind.Enum:
      return fromLiterals(literalValues(t).filter((x) => !deepEqual(x, v)));
    case SchemaKind.Const:
      return deepEqual(asObject(t).const!, v) ? false : t;
    case SchemaKind.Union: {
      const arms = unionArms(t) ?? [];
      return unionOf(arms.map((a) => excludeLiteral(a, v, defs)));
    }
    default:
      return t;
  }
}

// Truthiness (docs/language.md): `false`, `null`, `0`, and `""` are falsy;
// every other value — including all arrays/objects, any non-zero number, and
// any non-empty string — is truthy.
function isFalsyValue(v: JSONType): boolean {
  return v === false || v === null || v === 0 || v === "";
}

// Narrow a schema to just its truthy (`wantTruthy`) or falsy inhabitants — the
// slice of a value that a short-circuit `$or`/`$and` operand contributes when
// control passes through it. A *sound* refinement: categories we can't split
// exactly (a bare `number`/`string` minus its single falsy value isn't
// expressible) widen back to the whole type rather than under-approximate.
function narrowTruthiness(s: Schema, wantTruthy: boolean, defs: Defs): Schema {
  const t = resolveDeep(s, defs);
  // any: its falsy side is exactly the four falsy literals; its truthy side has
  // no finite complement, so it stays `any`.
  if (t === true) return wantTruthy ? true : { enum: [false, null, 0, ""] };
  if (t === false) return false; // never

  const arms = unionArms(t);
  if (arms) return unionOf(arms.map((a) => narrowTruthiness(a, wantTruthy, defs)));

  switch (classifySchema(t)) {
    case SchemaKind.Const:
      return isFalsyValue(literalValues(t)[0]!) === !wantTruthy ? t : false;
    case SchemaKind.Enum:
      return fromLiterals(literalValues(t).filter((v) => isFalsyValue(v) === !wantTruthy));
    case SchemaKind.Primitive: {
      const type = asObject(t).type as string;
      if (type === "null") return wantTruthy ? false : t; // null is always falsy
      if (type === "boolean") return { const: wantTruthy }; // true vs. false
      // number/integer split off only `0`; string splits off only `""`.
      if (type === "number" || type === "integer") return wantTruthy ? t : { const: 0 };
      if (type === "string") return wantTruthy ? t : { const: "" };
      return t;
    }
    case SchemaKind.Array:
    case SchemaKind.Tuple:
    case SchemaKind.Object:
    case SchemaKind.FnType:
      return wantTruthy ? t : false; // composites & functions are always truthy
    default:
      return t; // Opaque: leave untouched (sound over-approximation)
  }
}

function restrictToTruthy(s: Schema, defs: Defs): Schema {
  return narrowTruthiness(s, true, defs);
}

function restrictToFalsy(s: Schema, defs: Defs): Schema {
  return narrowTruthiness(s, false, defs);
}

// Predicate-name → the value-type category it tests (the `isType` family).
const TYPE_PREDICATES: Record<string, string> = {
  isNull: "null",
  isBool: "boolean",
  isNumber: "number",
  isInteger: "integer",
  isString: "string",
  isArray: "array",
  isObject: "object",
};

// Is `name` an *unshadowed* builtin guard here? A user binding of the same name
// wins at runtime (§5.3 dispatch), so we must not narrow on it.
function isUnshadowed(name: string, ctx: CheckContext): boolean {
  return ctx.env.lookupType(name) === undefined;
}

// A raw value used as a condition narrows itself: it is truthy on the branch
// where the condition holds (`sense`), falsy otherwise. Applies to any static
// access path (a bare `$var` or a `base.field` chain); other expressions yield
// no fact.
function truthinessFact(expr: JSONType, sense: boolean, ctx: CheckContext): Record<string, Schema> {
  const subject = asPath(expr);
  if (subject === null) return {};
  const cur = currentTypeOfExpr(expr, ctx);
  if (cur === undefined) return {};
  return { [subject]: sense ? restrictToTruthy(cur, ctx.defs) : restrictToFalsy(cur, ctx.defs) };
}

// Facts learned about bare vars when `cond` evaluates to `sense` (true on the
// then/case branch, false on the else branch). Only forms whose subject is a
// bare `$var` produce a fact; everything else yields `{}` (→ M0 warning path).
function factsFromCondition(
  cond: JSONType,
  sense: boolean,
  ctx: CheckContext,
  seen: readonly string[] = [],
): Record<string, Schema> {
  if (!isSchemaObject(cond)) return {};

  // A bare-var condition may be a *named boolean guard* — a lazy local like
  // `empty: isNull(target)` used as `cond { empty -> … }` (§2.3). Recurse into
  // its binding expression; `seen` breaks alias cycles (`ok: not(empty)`,
  // `empty: not(ok)`), which fall back to the plain truthiness fact below.
  const guardVar = asVarName(cond);
  if (guardVar !== null) {
    const guardExpr = ctx.guards?.[guardVar];
    if (guardExpr !== undefined && !seen.includes(guardVar)) {
      const facts = factsFromCondition(guardExpr, sense, ctx, [...seen, guardVar]);
      if (Object.keys(facts).length > 0) return facts;
    }
    // Not a named boolean guard: the bare value *is* the condition, so it is
    // known-truthy on the then-branch and known-falsy on the else-branch. This
    // is the `$if`/`$or`/`$and`-idiom parallel (`if x then x` drops `null`).
    return truthinessFact(cond, sense, ctx);
  }

  // `$and` learns a conjunction only when true; `$or` only when false. The dual
  // cases (`$and` false / `$or` true) yield no sound single-var fact.
  if (Array.isArray(cond.$and)) return sense ? conjoin(cond.$and, true, ctx, seen) : {};
  if (Array.isArray(cond.$or)) return sense ? {} : conjoin(cond.$or, false, ctx, seen);

  // A non-call, non-var condition may still be a static access path (e.g.
  // `u.active`): use the value's own truthiness as the fact.
  if (!("$call" in cond) || typeof cond.$call !== "string") return truthinessFact(cond, sense, ctx);
  const name = cond.$call;
  const args = Array.isArray(cond.$args) ? cond.$args : [];
  if (!isUnshadowed(name, ctx)) return {};

  if (name === "not" && args.length === 1) return factsFromCondition(args[0]!, !sense, ctx, seen);

  if (name in TYPE_PREDICATES && args.length === 1) {
    // The subject may be a bare `$var` (M1) or a static access path like
    // `move.from` (M3); both serialize to a `ctx.narrowings` key via `asPath`.
    const subject = asPath(args[0]!);
    if (subject === null) return {};
    const cur = currentTypeOfExpr(args[0]!, ctx);
    if (cur === undefined) return {};
    const typeName = TYPE_PREDICATES[name]!;
    const narrowed = sense
      ? restrictToType(cur, typeName, ctx.defs)
      : removeType(cur, typeName, ctx.defs);
    return { [subject]: narrowed };
  }

  if ((name === "eq" || name === "neq") && args.length === 2) {
    // neq is eq with the sense flipped.
    return equalityFact(args[0]!, args[1]!, name === "neq" ? !sense : sense, ctx);
  }

  return {};
}

function discriminantSubject(
  subjectNode: JSONType,
  ctx: CheckContext,
): { base: string; field: string; type: Schema } | null {
  if (nodeKind(subjectNode) !== "get") return null;
  const o = subjectNode as { $get: JSONType; $from: JSONType };
  const base = asVarName(o.$from);
  if (base === null || typeof o.$get !== "string") return null;
  const type = currentType(base, ctx);
  if (type === undefined) return null;
  return { base, field: o.$get, type };
}

function matchCaseFact(
  subjectNode: JSONType,
  lit: JSONType,
  ctx: CheckContext,
): Record<string, Schema> {
  const subject = asVarName(subjectNode);
  if (subject !== null) {
    const cur = currentType(subject, ctx);
    if (cur === undefined) return {};
    return { [subject]: restrictToLiteral(cur, lit, ctx.defs) };
  }

  const discriminant = discriminantSubject(subjectNode, ctx);
  if (discriminant === null) return {};
  return {
    [discriminant.base]: restrictToDiscriminant(
      discriminant.type,
      discriminant.field,
      lit,
      true,
      ctx.defs,
    ),
  };
}

function matchElseFact(
  subjectNode: JSONType,
  matched: JSONType[],
  ctx: CheckContext,
): Record<string, Schema> {
  const subject = asVarName(subjectNode);
  if (subject !== null) {
    const cur = currentType(subject, ctx);
    if (cur === undefined) return {};
    return { [subject]: matched.reduce((s, lit) => excludeLiteral(s, lit, ctx.defs), cur) };
  }

  const discriminant = discriminantSubject(subjectNode, ctx);
  if (discriminant === null) return {};
  return {
    [discriminant.base]: matched.reduce(
      (s, lit) => restrictToDiscriminant(s, discriminant.field, lit, false, ctx.defs),
      discriminant.type,
    ),
  };
}

// Fact from `x == <lit>` (either argument order). The literal side is whichever
// operand is a literal; the other is the subject. A *bare-var* subject is
// pinned to (true) / stripped of (false) the literal. A *field-path* subject
// (`x.tag == "A"`) is a discriminant: it narrows the base var `x` to the union
// arm(s) whose `tag` admits the literal (§5.5 M3).
function equalityFact(
  a: JSONType,
  b: JSONType,
  sense: boolean,
  ctx: CheckContext,
): Record<string, Schema> {
  let subjectNode: JSONType = a;
  let lit = litOf(b);
  if (lit === null) {
    subjectNode = b;
    lit = litOf(a);
  }
  if (lit === null) return {};

  const name = asVarName(subjectNode);
  if (name !== null) {
    const cur = currentType(name, ctx);
    if (cur === undefined) return {};
    const narrowed = sense
      ? restrictToLiteral(cur, lit.v, ctx.defs)
      : excludeLiteral(cur, lit.v, ctx.defs);
    return { [name]: narrowed };
  }

  // Discriminated-union narrowing: `base.field == lit` refines `base`.
  if (nodeKind(subjectNode) === "get") {
    const o = subjectNode as { $get: JSONType; $from: JSONType };
    const base = asVarName(o.$from);
    if (base === null || typeof o.$get !== "string") return {};
    const cur = currentType(base, ctx);
    if (cur === undefined) return {};
    return { [base]: restrictToDiscriminant(cur, o.$get, lit.v, sense, ctx.defs) };
  }
  return {};
}

// Meet a union with "arm's `field` (dis)agrees with `lit`" (§5.5 M3). On the
// true branch keep arms whose `field` could hold `lit`; on the false branch
// drop arms whose `field` is *exactly* `const lit` (the discriminant match).
// A singleton `enum` is the same schema as a `const` and counts as exact.
// A no-op for non-unions (nothing to discriminate).
function restrictToDiscriminant(
  s: Schema,
  field: string,
  lit: JSONType,
  sense: boolean,
  defs: Defs,
): Schema {
  const arms = unionArms(resolveDeep(s, defs));
  if (!arms) return s;
  const kept = arms.filter((arm) => {
    const fieldT = resolveDeep(projectField(arm, field, defs), defs);
    if (sense) return valueSatisfies(lit, fieldT, defs);
    const kind = classifySchema(fieldT);
    const isExact =
      (kind === SchemaKind.Const || kind === SchemaKind.Enum) &&
      literalValues(fieldT).length === 1 &&
      deepEqual(literalValues(fieldT)[0]!, lit);
    return !isExact;
  });
  return unionOf(kept);
}

// The finite set of scalar values a schema admits, or null when the schema is
// not a finite literal set (an infinite primitive, `any`, or a composite). The
// singleton `null`/`boolean` types count — their inhabitants *are* enumerable —
// which lets a `T | null` subject be checked for a missing `null` case (§5.6).
function enumerateLiterals(s: Schema, defs: Defs): JSONType[] | null {
  const t = resolveDeep(s, defs);
  switch (classifySchema(t)) {
    case SchemaKind.Const:
    case SchemaKind.Enum:
      return literalValues(t);
    case SchemaKind.Union: {
      const arms = unionArms(t) ?? [];
      const out: JSONType[] = [];
      for (const arm of arms) {
        const lits = enumerateLiterals(arm, defs);
        if (lits === null) return null; // an infinite arm ⇒ not enumerable
        out.push(...lits);
      }
      return out;
    }
    case SchemaKind.Primitive: {
      const type = asObject(t).type;
      if (type === "null") return [null];
      if (type === "boolean") return [false, true];
      return null; // string / number / integer are infinite
    }
    default:
      return null;
  }
}

// The finite set of literal values a `field` takes across the arms of a union
// (a discriminant's tags), or null when it isn't a clean finite discriminant —
// the base isn't a union, or some arm's `field` isn't a finite literal set.
// Generalizes the arm-scan in `restrictToDiscriminant` for the §5.6 lint: there
// it asked "which arm does this narrow to?", here "what tags exist to cover?".
function discriminantValues(s: Schema, field: string, defs: Defs): JSONType[] | null {
  const arms = unionArms(resolveDeep(s, defs));
  if (!arms) return null;
  const out: JSONType[] = [];
  for (const arm of arms) {
    const lits = enumerateLiterals(projectField(arm, field, defs), defs);
    if (lits === null) return null;
    out.push(...lits);
  }
  return out;
}

// The finite universe of scalar values a `$match` subject can take, for the
// §5.6 exhaustiveness / dead-case lints. Two shapes are recognized:
//   * a subject whose own type is a finite literal set (an enum var, a union of
//     consts, `null`/`boolean`) — the enum-exhaustiveness case;
//   * a discriminant path `base.field` where `base` is a union pinning `field`
//     to a const per arm — the discriminated-union case. Projection over a
//     union collapses to `any`, so this scans the arms directly (shared with
//     discriminant narrowing).
// Returns null when the universe is not a finite literal set, so exhaustiveness
// is undecidable and the lint stays quiet (e.g. a `string`-typed subject).
function caseUniverse(
  subjectNode: JSONType,
  subjectType: Schema,
  ctx: CheckContext,
): JSONType[] | null {
  const direct = enumerateLiterals(subjectType, ctx.defs);
  if (direct !== null) return direct;
  if (nodeKind(subjectNode) === "get") {
    const o = subjectNode as { $get: JSONType; $from: JSONType };
    if (typeof o.$get === "string") {
      const baseT = currentTypeOfExpr(o.$from, ctx);
      if (baseT !== undefined) return discriminantValues(baseT, o.$get, ctx.defs);
    }
  }
  return null;
}

// Fold a `$and`/`$or` arm list into a single fact map, threading each arm's
// facts forward so a later arm refines an earlier one on the same var.
function conjoin(
  exprs: JSONType[],
  sense: boolean,
  ctx: CheckContext,
  seen: readonly string[] = [],
): Record<string, Schema> {
  let acc: Record<string, Schema> = {};
  let cur = ctx;
  for (const e of exprs) {
    const facts = factsFromCondition(e, sense, cur, seen);
    if (Object.keys(facts).length === 0) continue;
    acc = { ...acc, ...facts };
    cur = withNarrowings(cur, facts);
  }
  return acc;
}

export {
  withNarrowings,
  factsFromCondition,
  currentType,
  removeType,
  restrictToLiteral,
  excludeLiteral,
  restrictToTruthy,
  restrictToFalsy,
  caseUniverse,
  matchCaseFact,
  matchElseFact,
};
