// Static type checker for json-fn — a mirror of the runtime evaluator that
// produces/compares *types* instead of *values*. This module is deliberately
// isolated: it imports only pure types from `./types` and never touches the
// evaluator. Inputs are assumed to be well-formed, already-lowered JSON — both
// the program AST and the type representations (JSON Schema + `$ref` + the one
// non-schema `$fnType` node) — so the classifier is a thin discriminant switch,
// not the defensive validation the evaluator performs.
//
// Sections implemented so far (see plans/type-sketch.md for the full design):
//   B. Schema classification         — `classifySchema`
//   C. Subschema check (S ⊆ T)        — `isSubschema`, plus `valueSatisfies`

import type { JSONType } from "./types";

// A type is represented as canonical-fragment JSON Schema, extended with
// `$ref` (named types) and the distinguished `$fnType` node (§2.8). Boolean
// schemas `true`/`false` encode `any`/`never`.
type Schema = JSONType;

// The module-level `$types` pool (`$defs`), used to resolve `$ref`.
type Defs = Record<string, Schema>;

// ---------------------------------------------------------------------------
// Section B — Schema classification
// ---------------------------------------------------------------------------

// The counterpart to the evaluator's `ExpressionType`, but over schemas. The
// canonical shorthand can only emit this fragment; anything else is `Opaque`
// (§5.1 escape hatch), statically compatible only with `any` or a structurally
// equal self.
enum SchemaKind {
  Any, // true
  Never, // false
  Primitive, // { type: "null" | "boolean" | "number" | "integer" | "string" } (+ refinements)
  Const, // { const: ... }
  Enum, // { enum: [...] }
  Union, // { anyOf: [...] } or a type-array { type: [...] }
  Array, // { type: "array", items?: ... }
  Tuple, // { type: "array", prefixItems: [...] }
  Object, // { type: "object", ... } (includes the map form)
  Ref, // { $ref: "#/$defs/Name" }
  FnType, // { $fnType: { params, rest?, returns } }
  Opaque, // anything outside the tractable fragment
}

function isSchemaObject(s: Schema): s is Record<string, JSONType> {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

function classifySchema(s: Schema): SchemaKind {
  if (s === true) return SchemaKind.Any;
  if (s === false) return SchemaKind.Never;
  if (!isSchemaObject(s)) return SchemaKind.Opaque;

  if ("$ref" in s) return SchemaKind.Ref;
  if ("$fnType" in s) return SchemaKind.FnType;
  if ("const" in s) return SchemaKind.Const;
  if ("enum" in s) return SchemaKind.Enum;
  if ("anyOf" in s) return SchemaKind.Union;

  const t = s.type;
  if (Array.isArray(t)) return SchemaKind.Union; // type-array union, e.g. ["number", "null"]
  if (typeof t === "string") {
    if (t === "array") return "prefixItems" in s ? SchemaKind.Tuple : SchemaKind.Array;
    if (t === "object") return SchemaKind.Object;
    return SchemaKind.Primitive; // null | boolean | number | integer | string
  }

  return SchemaKind.Opaque;
}

// ---------------------------------------------------------------------------
// Small accessors / structural helpers
// ---------------------------------------------------------------------------

function asObject(s: Schema): Record<string, JSONType> {
  return s as Record<string, JSONType>;
}

function refName(s: Schema): string {
  return String(asObject(s).$ref).replace(/^#\/\$defs\//, "");
}

// Resolve a `$ref` against the defs pool. Well-formed input always resolves; a
// missing def is treated as `any` (permissive) rather than throwing, so the
// pure checker never crashes on malformed hand-written schemas.
function resolveRef(s: Schema, defs: Defs): Schema {
  const name = refName(s);
  const def = defs[name];
  return def === undefined ? true : def;
}

// Decompose a union into its arms. `anyOf` → its arms verbatim; a type-array →
// one bare-primitive schema per listed type. Returns null for non-unions
// (Const/Enum are handled separately, value-wise).
function unionArms(s: Schema): Schema[] | null {
  if (!isSchemaObject(s)) return null;
  if (Array.isArray(s.anyOf)) return s.anyOf;
  if (Array.isArray(s.type)) return s.type.map((t) => ({ type: t }));
  return null;
}

// The literal values carried by a Const/Enum schema.
function literalValues(s: Schema): JSONType[] {
  const o = asObject(s);
  if ("const" in o) return [o.const!];
  return (o.enum as JSONType[]) ?? [];
}

function deepEqual(a: JSONType, b: JSONType): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]!));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in b && deepEqual(a[k]!, (b as Record<string, JSONType>)[k]!));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Section C — Subschema check (S ⊆ T)
// ---------------------------------------------------------------------------

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

// --- Primitives & refinements ---------------------------------------------

function primitiveSubsumes(sub: Record<string, JSONType>, sup: Record<string, JSONType>): boolean {
  const subT = sub.type as string;
  const supT = sup.type as string;
  const typeOk = subT === supT || (subT === "integer" && supT === "number");
  if (!typeOk) return false;
  return refinementsSubsume(sub, sup);
}

type Bound = { v: number; excl: boolean };

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

// --- Arrays & tuples -------------------------------------------------------

function itemsSchema(o: Record<string, JSONType>): Schema {
  return "items" in o ? o.items! : true; // omitted items == any
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

function prefixItems(o: Record<string, JSONType>): Schema[] {
  return Array.isArray(o.prefixItems) ? o.prefixItems : [];
}

// A tuple's rest element (its `items` schema), or null when the tuple is closed
// (`items: false`).
function tupleRest(o: Record<string, JSONType>): Schema | null {
  if (!("items" in o)) return null;
  return o.items === false ? null : o.items!;
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

// --- Objects ---------------------------------------------------------------

type ApMode = { kind: "closed" } | { kind: "open" } | { kind: "map"; schema: Schema };

// Interpret `additionalProperties` under the shorthand's *closed-by-default*
// convention (§2.5): omitted/`true` means open, `false` means closed, a schema
// means a map over the non-listed keys.
function apMode(o: Record<string, JSONType>): ApMode {
  if (!("additionalProperties" in o)) return { kind: "open" };
  const ap = o.additionalProperties;
  if (ap === false) return { kind: "closed" };
  if (ap === true) return { kind: "open" };
  return { kind: "map", schema: ap! };
}

function properties(o: Record<string, JSONType>): Record<string, Schema> {
  const p = o.properties;
  return p !== undefined && isSchemaObject(p) ? p : {};
}

function requiredKeys(o: Record<string, JSONType>): string[] {
  return Array.isArray(o.required) ? (o.required as string[]) : [];
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

// --- Function types --------------------------------------------------------

type FnTypeShape = { params: Schema[]; rest?: Schema; returns: Schema };

function fnShape(o: Record<string, JSONType>): FnTypeShape {
  const ft = asObject(o.$fnType!);
  return {
    params: Array.isArray(ft.params) ? ft.params : [],
    rest: "rest" in ft ? ft.rest : undefined,
    returns: "returns" in ft ? ft.returns! : true,
  };
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

// ---------------------------------------------------------------------------
// Value/schema validation — the seed of runtime checking (§6), also used to
// decide Const/Enum subschema membership above.
// ---------------------------------------------------------------------------

function valueType(v: JSONType): "null" | "boolean" | "number" | "string" | "array" | "object" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "boolean" || t === "number" || t === "string") return t;
  return "object";
}

function typeMatches(v: JSONType, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number";
  return valueType(v) === t;
}

// Does a concrete JSON value satisfy a schema?
function valueSatisfies(value: JSONType, schema: Schema, defs: Defs = {}): boolean {
  const kind = classifySchema(schema);
  switch (kind) {
    case SchemaKind.Any:
      return true;
    case SchemaKind.Never:
      return false;
    case SchemaKind.Ref:
      return valueSatisfies(value, resolveRef(schema, defs), defs);
    case SchemaKind.Const:
      return deepEqual(value, asObject(schema).const!);
    case SchemaKind.Enum:
      return literalValues(schema).some((v) => deepEqual(value, v));
    case SchemaKind.Union:
      return (unionArms(schema) ?? []).some((arm) => valueSatisfies(value, arm, defs));
    case SchemaKind.Primitive:
      return primitiveValueMatches(value, asObject(schema));
    case SchemaKind.Array:
    case SchemaKind.Tuple:
      return arrayValueMatches(value, asObject(schema), defs);
    case SchemaKind.Object:
      return objectValueMatches(value, asObject(schema), defs);
    case SchemaKind.FnType:
      // Function-value validation (shape + embedded `$sig`) is a later concern;
      // a plain data literal never satisfies a function type.
      return false;
    case SchemaKind.Opaque:
      return false; // not statically decidable
  }
}

function primitiveValueMatches(value: JSONType, o: Record<string, JSONType>): boolean {
  if (!typeMatches(value, o.type as string)) return false;
  if (typeof value === "number") {
    if ("minimum" in o && value < (o.minimum as number)) return false;
    if ("maximum" in o && value > (o.maximum as number)) return false;
    if ("exclusiveMinimum" in o && value <= (o.exclusiveMinimum as number)) return false;
    if ("exclusiveMaximum" in o && value >= (o.exclusiveMaximum as number)) return false;
    if ("multipleOf" in o && value % (o.multipleOf as number) !== 0) return false;
  }
  if (typeof value === "string") {
    if ("minLength" in o && value.length < (o.minLength as number)) return false;
    if ("maxLength" in o && value.length > (o.maxLength as number)) return false;
    if ("pattern" in o && !new RegExp(o.pattern as string).test(value)) return false;
  }
  return true;
}

function arrayValueMatches(value: JSONType, o: Record<string, JSONType>, defs: Defs): boolean {
  if (!Array.isArray(value)) return false;
  if ("minItems" in o && value.length < (o.minItems as number)) return false;
  if ("maxItems" in o && value.length > (o.maxItems as number)) return false;

  const prefix = prefixItems(o);
  const rest = "prefixItems" in o ? tupleRest(o) : itemsSchema(o);
  for (let i = 0; i < value.length; i++) {
    const elemSchema = prefix[i] ?? rest;
    if (elemSchema === null || elemSchema === undefined) return false; // closed tuple overflow
    if (!valueSatisfies(value[i]!, elemSchema, defs)) return false;
  }
  if (prefix.length > value.length) return false; // missing required tuple elements

  if (o.uniqueItems === true) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i]!, value[j]!)) return false;
      }
    }
  }
  return true;
}

function objectValueMatches(value: JSONType, o: Record<string, JSONType>, defs: Defs): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, JSONType>;

  for (const k of requiredKeys(o)) {
    if (!(k in v)) return false;
  }

  const props = properties(o);
  const mode = apMode(o);
  for (const [k, val] of Object.entries(v)) {
    if (k in props) {
      if (!valueSatisfies(val, props[k]!, defs)) return false;
    } else if (mode.kind === "closed") {
      return false;
    } else if (mode.kind === "map" && !valueSatisfies(val, mode.schema, defs)) {
      return false;
    }
  }
  return true;
}

export { SchemaKind, classifySchema, isSubschema, valueSatisfies };
export type { Schema, Defs };
