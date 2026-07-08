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
import { asVarName, litOf } from "./ast";
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
  unionArms,
  unionOf,
  deepEqual,
  isSchemaObject,
} from "./schema";
import { isSubschema } from "./subsumption";
import { valueSatisfies } from "./values";

// The type a var has *right now*: its active narrowing if any, else its
// declared type from Γ. `undefined` when the name is unbound (can't narrow).
function currentType(name: string, ctx: CheckContext): Schema | undefined {
  return ctx.narrowings?.[name] ?? ctx.env.lookupType(name);
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
  if (typeName === "number" || typeName === "integer") return typeof v === "number";
  return valueType(v) === typeName;
}

// Does an arm *overlap* the values of primitive category `typeName` (used on
// the true branch of a type predicate)? A conservative "could this arm produce
// such a value" test.
function armMatchesType(arm: Schema, typeName: string, defs: Defs): boolean {
  const t = resolveDeep(arm, defs);
  if (t === true) return true;
  if (t === false) return false;
  switch (classifySchema(t)) {
    case SchemaKind.Primitive: {
      const at = asObject(t).type as string;
      if (at === typeName) return true;
      return (
        (typeName === "number" && at === "integer") || (typeName === "integer" && at === "number")
      );
    }
    case SchemaKind.Const:
      return valueTypeMatches(asObject(t).const!, typeName);
    case SchemaKind.Enum:
      return literalValues(t).some((v) => valueTypeMatches(v, typeName));
    case SchemaKind.Union:
      return (unionArms(t) ?? []).some((a) => armMatchesType(a, typeName, defs));
    case SchemaKind.Array:
    case SchemaKind.Tuple:
      return typeName === "array";
    case SchemaKind.Object:
      return typeName === "object";
    default:
      return false;
  }
}

// Rebuild an enum/const schema from a surviving literal set (empty ⇒ never).
function fromLiterals(vals: JSONType[]): Schema {
  if (vals.length === 0) return false;
  if (vals.length === 1) return { const: vals[0]! };
  return { enum: vals };
}

// Meet with "value is of category `typeName`": keep only the arms that could
// produce such a value. `T | null` narrowed to non-null falls out of the
// mirror `removeType`.
function restrictToType(s: Schema, typeName: string, defs: Defs): Schema {
  const t = resolveDeep(s, defs);
  const arms = unionArms(t);
  if (arms) return unionOf(arms.filter((a) => armMatchesType(a, typeName, defs)));
  if (classifySchema(t) === SchemaKind.Enum) {
    return fromLiterals(literalValues(t).filter((v) => valueTypeMatches(v, typeName)));
  }
  return armMatchesType(t, typeName, defs) ? t : false;
}

// Meet with "value is NOT of category `typeName`": drop arms wholly contained
// in that category. `Cell` on the `isNull`-false branch → `Piece`.
function removeType(s: Schema, typeName: string, defs: Defs): Schema {
  const probe: Schema = { type: typeName };
  const t = resolveDeep(s, defs);
  const arms = unionArms(t);
  if (arms) return unionOf(arms.filter((a) => !isSubschema(a, probe, defs)));
  if (classifySchema(t) === SchemaKind.Enum) {
    return fromLiterals(literalValues(t).filter((v) => !valueTypeMatches(v, typeName)));
  }
  return isSubschema(t, probe, defs) ? false : t;
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

// Predicate-name → the value-type category it tests (the `isType` family).
const TYPE_PREDICATES: Record<string, string> = {
  isNull: "null",
  isBool: "boolean",
  isNumber: "number",
  isString: "string",
  isArray: "array",
  isObject: "object",
};

// Is `name` an *unshadowed* builtin guard here? A user binding of the same name
// wins at runtime (§5.3 dispatch), so we must not narrow on it.
function isUnshadowed(name: string, ctx: CheckContext): boolean {
  return ctx.env.lookupType(name) === undefined;
}

// Facts learned about bare vars when `cond` evaluates to `sense` (true on the
// then/case branch, false on the else branch). Only forms whose subject is a
// bare `$var` produce a fact; everything else yields `{}` (→ M0 warning path).
function factsFromCondition(
  cond: JSONType,
  sense: boolean,
  ctx: CheckContext,
): Record<string, Schema> {
  if (!isSchemaObject(cond)) return {};

  // `$and` learns a conjunction only when true; `$or` only when false. The dual
  // cases (`$and` false / `$or` true) yield no sound single-var fact.
  if (Array.isArray(cond.$and)) return sense ? conjoin(cond.$and, true, ctx) : {};
  if (Array.isArray(cond.$or)) return sense ? {} : conjoin(cond.$or, false, ctx);

  if (!("$call" in cond) || typeof cond.$call !== "string") return {};
  const name = cond.$call;
  const args = Array.isArray(cond.$args) ? cond.$args : [];
  if (!isUnshadowed(name, ctx)) return {};

  if (name === "not" && args.length === 1) return factsFromCondition(args[0]!, !sense, ctx);

  if (name in TYPE_PREDICATES && args.length === 1) {
    const subject = asVarName(args[0]!);
    if (subject === null) return {};
    const cur = currentType(subject, ctx);
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

// Fact from `x == <lit>` (either argument order). On the true branch the var is
// pinned to the literal; on the false branch the literal is excluded.
function equalityFact(
  a: JSONType,
  b: JSONType,
  sense: boolean,
  ctx: CheckContext,
): Record<string, Schema> {
  let subject = asVarName(a);
  let lit = litOf(b);
  if (subject === null || lit === null) {
    subject = asVarName(b);
    lit = litOf(a);
  }
  if (subject === null || lit === null) return {};
  const cur = currentType(subject, ctx);
  if (cur === undefined) return {};
  const narrowed = sense
    ? restrictToLiteral(cur, lit.v, ctx.defs)
    : excludeLiteral(cur, lit.v, ctx.defs);
  return { [subject]: narrowed };
}

// Fold a `$and`/`$or` arm list into a single fact map, threading each arm's
// facts forward so a later arm refines an earlier one on the same var.
function conjoin(exprs: JSONType[], sense: boolean, ctx: CheckContext): Record<string, Schema> {
  let acc: Record<string, Schema> = {};
  let cur = ctx;
  for (const e of exprs) {
    const facts = factsFromCondition(e, sense, cur);
    if (Object.keys(facts).length === 0) continue;
    acc = { ...acc, ...facts };
    cur = withNarrowings(cur, facts);
  }
  return acc;
}

export { withNarrowings, factsFromCondition, currentType, restrictToLiteral, excludeLiteral };
