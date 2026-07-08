import type { JSONType } from "../types";
import {
  type Defs,
  type Schema,
  classifySchema,
  SchemaKind,
  refName,
  resolveRef,
  literalValues,
  unionArms,
  asObject,
  deepEqual,
  itemsSchema,
  prefixItems,
  tupleRest,
  type Bound,
  apMode,
  properties,
  requiredKeys,
  fnShape,
} from "./schema";
import { valueSatisfies } from "./values";

type SubCtx = {
  defs: Defs;
  // Coinductive guard for recursive `$ref` types: a pair of ref names already
  // under comparison is assumed to succeed on revisit (§5.1).
  seen: Set<string>;
};

// Public entry: does every value matching `sub` also match `sup`?
function isSubschema(sub: Schema, sup: Schema, defs: Defs = {}): boolean {
  return subsumes(sub, sup, { defs, seen: new Set() });
}

function subsumes(sub: Schema, sup: Schema, ctx: SubCtx): boolean {
  // Boolean-schema base cases (no ref resolution needed).
  if (sup === true) return true; // T = any
  if (sub === true) return false; // any ⊆ (non-any)
  if (sub === false) return true; // never ⊆ T
  if (sup === false) return false; // (non-never) ⊆ never

  // `$ref` handling. Guard only when *both* sides are refs — that is the only
  // way a contractive recursive comparison can revisit a pair. Otherwise
  // resolving the ref side makes structural progress.
  const subRef = classifySchema(sub) === SchemaKind.Ref;
  const supRef = classifySchema(sup) === SchemaKind.Ref;
  if (subRef && supRef) {
    const key = `${refName(sub)}<:${refName(sup)}`;
    if (ctx.seen.has(key)) return true;
    ctx.seen.add(key);
    return subsumes(resolveRef(sub, ctx.defs), resolveRef(sup, ctx.defs), ctx);
  }
  if (subRef) return subsumes(resolveRef(sub, ctx.defs), sup, ctx);
  if (supRef) return subsumes(sub, resolveRef(sup, ctx.defs), ctx);

  const subK = classifySchema(sub);
  const supK = classifySchema(sup);

  // Literal sub: every literal it admits must satisfy sup.
  if (subK === SchemaKind.Const || subK === SchemaKind.Enum) {
    return literalValues(sub).every((v) => valueSatisfies(v, sup, ctx.defs));
  }

  // Union sub: every arm must be ⊆ sup.
  const subArms = unionArms(sub);
  if (subArms) return subArms.every((arm) => subsumes(arm, sup, ctx));

  // Union sup (with an atomic, non-literal sub): sub must fit some arm.
  const supArms = unionArms(sup);
  if (supArms) return supArms.some((arm) => subsumes(sub, arm, ctx));

  // An atomic, non-literal sub can never fit a finite literal set.
  if (supK === SchemaKind.Const || supK === SchemaKind.Enum) return false;

  switch (subK) {
    case SchemaKind.Primitive:
      return supK === SchemaKind.Primitive && primitiveSubsumes(asObject(sub), asObject(sup));
    case SchemaKind.Array:
      if (supK === SchemaKind.Array) return arraySubsumesArray(asObject(sub), asObject(sup), ctx);
      return false; // v1: a variable-length array never fits a fixed tuple.
    case SchemaKind.Tuple:
      if (supK === SchemaKind.Tuple) return tupleSubsumesTuple(asObject(sub), asObject(sup), ctx);
      if (supK === SchemaKind.Array) return tupleSubsumesArray(asObject(sub), asObject(sup), ctx);
      return false;
    case SchemaKind.Object:
      return supK === SchemaKind.Object && objectSubsumes(asObject(sub), asObject(sup), ctx);
    case SchemaKind.FnType:
      return supK === SchemaKind.FnType && fnSubsumes(asObject(sub), asObject(sup), ctx);
    case SchemaKind.Opaque:
      // Opaque schemas are compatible only with a structurally identical self
      // (Any was handled above); everything else defers to runtime.
      return deepEqual(sub, sup);
    default:
      return false;
  }
}

function primitiveSubsumes(sub: Record<string, JSONType>, sup: Record<string, JSONType>): boolean {
  const subT = sub.type as string;
  const supT = sup.type as string;
  const typeOk = subT === supT || (subT === "integer" && supT === "number");
  if (!typeOk) return false;
  return refinementsSubsume(sub, sup);
}

function lowerBound(o: Record<string, JSONType>): Bound | null {
  const hasMin = "minimum" in o;
  const hasX = "exclusiveMinimum" in o;
  if (hasMin && hasX) {
    const m = o.minimum as number;
    const x = o.exclusiveMinimum as number;
    return m > x ? { v: m, excl: false } : { v: x, excl: true };
  }
  if (hasMin) return { v: o.minimum as number, excl: false };
  if (hasX) return { v: o.exclusiveMinimum as number, excl: true };
  return null;
}

function upperBound(o: Record<string, JSONType>): Bound | null {
  const hasMax = "maximum" in o;
  const hasX = "exclusiveMaximum" in o;
  if (hasMax && hasX) {
    const m = o.maximum as number;
    const x = o.exclusiveMaximum as number;
    return m < x ? { v: m, excl: false } : { v: x, excl: true };
  }
  if (hasMax) return { v: o.maximum as number, excl: false };
  if (hasX) return { v: o.exclusiveMaximum as number, excl: true };
  return null;
}

// sub's lower bound must sit at or inside sup's lower bound.
function lowerOk(subB: Bound | null, supB: Bound | null): boolean {
  if (supB === null) return true;
  if (subB === null) return false; // sub unbounded below
  if (subB.v > supB.v) return true;
  if (subB.v === supB.v) return subB.excl || !supB.excl;
  return false;
}

function upperOk(subB: Bound | null, supB: Bound | null): boolean {
  if (supB === null) return true;
  if (subB === null) return false;
  if (subB.v < supB.v) return true;
  if (subB.v === supB.v) return subB.excl || !supB.excl;
  return false;
}

function refinementsSubsume(sub: Record<string, JSONType>, sup: Record<string, JSONType>): boolean {
  // Numeric ranges.
  if (!lowerOk(lowerBound(sub), lowerBound(sup))) return false;
  if (!upperOk(upperBound(sub), upperBound(sup))) return false;

  // multipleOf: sub's step must be a multiple of sup's.
  if ("multipleOf" in sup) {
    if (!("multipleOf" in sub)) return false;
    if ((sub.multipleOf as number) % (sup.multipleOf as number) !== 0) return false;
  }

  // String length (inclusive integer bounds).
  if (
    "minLength" in sup &&
    (!("minLength" in sub) || (sub.minLength as number) < (sup.minLength as number))
  ) {
    return false;
  }
  if (
    "maxLength" in sup &&
    (!("maxLength" in sub) || (sub.maxLength as number) > (sup.maxLength as number))
  ) {
    return false;
  }

  // Pattern/format: syntactic equality only (§5.1); mismatch defers to runtime,
  // which the static check treats as "not provable".
  if ("pattern" in sup && sub.pattern !== sup.pattern) return false;
  if ("format" in sup && sub.format !== sup.format) return false;

  return true;
}

function arrayLengthOk(sub: Record<string, JSONType>, sup: Record<string, JSONType>): boolean {
  if (
    "minItems" in sup &&
    (!("minItems" in sub) || (sub.minItems as number) < (sup.minItems as number))
  ) {
    return false;
  }
  if (
    "maxItems" in sup &&
    (!("maxItems" in sub) || (sub.maxItems as number) > (sup.maxItems as number))
  ) {
    return false;
  }
  if (sup.uniqueItems === true && sub.uniqueItems !== true) return false;
  return true;
}

function arraySubsumesArray(
  sub: Record<string, JSONType>,
  sup: Record<string, JSONType>,
  ctx: SubCtx,
): boolean {
  if (!subsumes(itemsSchema(sub), itemsSchema(sup), ctx)) return false;
  return arrayLengthOk(sub, sup);
}

function tupleSubsumesArray(
  sub: Record<string, JSONType>,
  sup: Record<string, JSONType>,
  ctx: SubCtx,
): boolean {
  const supItems = itemsSchema(sup);
  for (const pi of prefixItems(sub)) {
    if (!subsumes(pi, supItems, ctx)) return false;
  }
  const rest = tupleRest(sub);
  if (rest !== null && !subsumes(rest, supItems, ctx)) return false;
  return arrayLengthOk(sub, sup);
}

function tupleSubsumesTuple(
  sub: Record<string, JSONType>,
  sup: Record<string, JSONType>,
  ctx: SubCtx,
): boolean {
  const subP = prefixItems(sub);
  const supP = prefixItems(sup);
  const subRest = tupleRest(sub);
  const supRest = tupleRest(sup);
  const n = Math.max(subP.length, supP.length);

  for (let i = 0; i < n; i++) {
    const subE = subP[i] ?? subRest;
    const supE = supP[i] ?? supRest;
    if (supE === null || supE === undefined) return false; // sup admits no element here
    if (subE === null || subE === undefined) return false; // sub can't guarantee this position
    if (!subsumes(subE, supE, ctx)) return false;
  }

  if (supRest !== null) {
    if (subRest !== null && !subsumes(subRest, supRest, ctx)) return false;
  } else if (subRest !== null) {
    return false; // sub allows extra elements sup forbids
  }

  return arrayLengthOk(sub, sup);
}

// The schema `sup` applies to a key `k` (its own property, else its
// additional-properties rule). Returns null when `sup` forbids `k`.
function supSchemaForKey(sup: Record<string, JSONType>, k: string): Schema | null {
  const props = properties(sup);
  if (k in props) return props[k]!;
  const mode = apMode(sup);
  if (mode.kind === "closed") return null;
  if (mode.kind === "open") return true;
  return mode.schema;
}

function objectSubsumes(
  sub: Record<string, JSONType>,
  sup: Record<string, JSONType>,
  ctx: SubCtx,
): boolean {
  // sup's required keys must all be required by sub.
  const subRequired = new Set(requiredKeys(sub));
  for (const k of requiredKeys(sup)) {
    if (!subRequired.has(k)) return false;
  }

  // Every property sub declares must be allowed & compatibly typed by sup.
  const subProps = properties(sub);
  for (const [k, subSchema] of Object.entries(subProps)) {
    const supSchema = supSchemaForKey(sup, k);
    if (supSchema === null) return false;
    if (!subsumes(subSchema, supSchema, ctx)) return false;
  }

  // Additional keys sub may carry must be admissible under sup.
  const subMode = apMode(sub);
  const supMode = apMode(sup);
  if (subMode.kind === "open") {
    // sub allows arbitrary extra keys of any type; only ok if sup does too.
    if (supMode.kind !== "open") return false;
  } else if (subMode.kind === "map") {
    if (supMode.kind === "closed") return false;
    if (supMode.kind === "map" && !subsumes(subMode.schema, supMode.schema, ctx)) return false;
  }
  // subMode "closed" carries no extra keys — always fine.

  return true;
}

function fnSubsumes(
  sub: Record<string, JSONType>,
  sup: Record<string, JSONType>,
  ctx: SubCtx,
): boolean {
  const a = fnShape(sub);
  const b = fnShape(sup);

  // v1: strict arity (modulo rest). Loosen later if idiomatic code demands.
  if (a.params.length !== b.params.length) return false;

  // Params are contravariant: sup's param must be ⊆ sub's param.
  for (let i = 0; i < a.params.length; i++) {
    if (!subsumes(b.params[i]!, a.params[i]!, ctx)) return false;
  }

  // Rest element, also contravariant; presence must match in v1.
  if ((a.rest === undefined) !== (b.rest === undefined)) return false;
  if (a.rest !== undefined && b.rest !== undefined && !subsumes(b.rest, a.rest, ctx)) return false;

  // Return is covariant.
  return subsumes(a.returns, b.returns, ctx);
}

export { isSubschema };
