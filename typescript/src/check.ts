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
//   A. Check context / diagnostics    — `CheckContext`, `Diagnostic`
//   D. Type environment / scope       — `buildTypeScope` (eager params +
//                                        sibling sigs, lazy cycle-guarded locals)
//   E. Term checking (synth-first)     — `synth` / `check` / `nodeKind`
//   G. Module wiring (minimal)         — `checkModule`, `checkFunction`, `checkExpr`
//
// Not yet wired: the polymorphic builtin layer (§5.3) and contextual typing of
// un-annotated inline lambdas (§4.3) — both degrade to `any` for now.

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

function isSchemaObject(s: Schema | undefined): s is Record<string, JSONType> {
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

// ---------------------------------------------------------------------------
// Section A — Check context, diagnostics, and signature helpers
// ---------------------------------------------------------------------------
//
// The type-system counterpart to the runtime's `EvaluationContext`: one bag of
// state threaded through the walk. Unlike the evaluator, the checker
// *accumulates* diagnostics (recover-and-continue, assigning `any` on error)
// rather than failing fast, and it is structured for bidirectional checking
// (a `synth` mode and a `check`-against-expected mode).

// A single type error, with a JSON-ish path to its location (§6).
type Diagnostic = { path: string[]; message: string; expected?: Schema; actual?: Schema };

// The term scope Γ: term name → type. A flat lookup with a parent chain,
// mirroring the evaluator's `getVar`.
type TypeEnv = { lookupType: (name: string) => Schema | undefined };

type CheckContext = {
  // The module `$types` pool ($defs), resolving `$ref`. The type-NAME scope.
  defs: Defs;
  // The term scope (Γ) — mirrors the evaluator's `buildScope`/`getVar`.
  env: TypeEnv;
  // Accumulate; never throw.
  diagnostics: Diagnostic[];
  // Current location, for messages.
  path: string[];
};

// A function signature — the shape shared by a body's `$sig` and the inner of
// a `$fnType` node (§2.8, §3.1). Reuses `FnTypeShape`.
type Sig = FnTypeShape;

const EMPTY_ENV: TypeEnv = { lookupType: () => undefined };

function isBody(v: JSONType): v is Record<string, JSONType> {
  return isSchemaObject(v) && "$return" in v;
}

// The declared signature of a function body, or null when unannotated.
function sigOf(body: Record<string, JSONType>): Sig | null {
  const sig = body.$sig;
  if (!isSchemaObject(sig)) return null;
  return {
    params: Array.isArray(sig.params) ? (sig.params as Schema[]) : [],
    rest: "rest" in sig ? sig.rest : undefined,
    returns: "returns" in sig ? sig.returns! : true,
  };
}

// The *type* of a function body as a value: its `$fnType` node, or `any` when
// the body carries no `$sig` (unannotated — inferring it needs the contextual
// typing deferred to a later milestone).
function bodyFnTypeSchema(body: Record<string, JSONType>): Schema {
  const sig = body.$sig;
  return isSchemaObject(sig) ? { $fnType: sig } : true;
}

// Keys of an object-of-bindings that name a local binding (mirrors the
// evaluator's filter in `buildScope`), excluding the reserved keys.
function bindingKeys(body: Record<string, JSONType>): string[] {
  return Object.keys(body).filter((k) => {
    if (k === "$return" || k === "$params" || k === "$sig") return false;
    if (k === "$comment" && typeof body[k] === "string") return false;
    return true;
  });
}

// Diagnostics helper: push a mismatch, extending the current path.
function report(ctx: CheckContext, message: string, extra?: Partial<Diagnostic>): void {
  ctx.diagnostics.push({ path: [...ctx.path], message, ...extra });
}

// A child context at a nested path segment (used when descending into args,
// branches, elements, ...). Cheap object spread — same "thread the bag"
// discipline as the evaluator's context.
function at(ctx: CheckContext, segment: string): CheckContext {
  return { ...ctx, path: [...ctx.path, segment] };
}

// ---------------------------------------------------------------------------
// Section D — Type environment / scope (mirrors `buildScope` / `getVar`)
// ---------------------------------------------------------------------------
//
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

// ---------------------------------------------------------------------------
// Section E — Term checking (mirrors `evaluateExpression`)
// ---------------------------------------------------------------------------
//
// Bidirectional: `synth` infers a schema for an expression; `check` verifies an
// expression against an expected schema. This milestone is *synth-first* — it
// types a fully-`$sig`-annotated module. Contextual typing of un-annotated
// inline lambdas and the polymorphic builtin layer arrive in a later milestone;
// until then an unknown callee or un-annotated lambda degrades to `any`.

type NodeKind =
  | "scalar"
  | "array"
  | "object"
  | "var"
  | "call"
  | "ref"
  | "body"
  | "if"
  | "cond"
  | "match"
  | "and"
  | "or"
  | "get"
  | "raw";

// A thin discriminant switch — not the evaluator's validating classifier, since
// input is assumed well-formed. Ordering mirrors `classifyExpressionType`.
function nodeKind(node: JSONType): NodeKind {
  if (node === null) return "scalar";
  if (Array.isArray(node)) return "array";
  if (typeof node !== "object") return "scalar";
  const o = node as Record<string, JSONType>;
  if ("$var" in o) return "var";
  if ("$get" in o || "$from" in o) return "get";
  if ("$return" in o) return "body";
  if ("$call" in o || "$args" in o) return "call";
  if ("$fn" in o) return "ref";
  if ("$cond" in o) return "cond";
  if ("$match" in o || "$cases" in o) return "match";
  if ("$if" in o || "$then" in o) return "if";
  if ("$and" in o) return "and";
  if ("$or" in o) return "or";
  if ("$raw" in o) return "raw";
  return "object";
}

// Build a union schema from branch/arm types, flattening + deduping. Kept
// deliberately simple (an `anyOf`, which `subsumes` handles); the shorthand
// printer owns the §2.3 enum/type-array canonicalization.
function unionOf(schemas: Schema[]): Schema {
  const arms: Schema[] = [];
  for (const s of schemas) {
    if (s === true) return true; // any absorbs
    if (s === false) continue; // never drops out
    const nested = isSchemaObject(s) && Array.isArray(s.anyOf) ? (s.anyOf as Schema[]) : [s];
    for (const a of nested) {
      if (!arms.some((existing) => deepEqual(existing, a))) arms.push(a);
    }
  }
  if (arms.length === 0) return false;
  if (arms.length === 1) return arms[0]!;
  return { anyOf: arms };
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
      return unionOf([synth(c.$then, at(ctx, "$then")), synth(c.$else, at(ctx, "$else"))]);
    }

    case "cond": {
      const c = expr as { $cond: [JSONType, JSONType][]; $else?: JSONType };
      const arms: Schema[] = [];
      c.$cond.forEach(([cond, result], i) => {
        synth(cond, at(ctx, `$cond[${i}][0]`));
        arms.push(synth(result, at(ctx, `$cond[${i}][1]`)));
      });
      if ("$else" in c) arms.push(synth(c.$else!, at(ctx, "$else")));
      return unionOf(arms);
    }

    case "match": {
      const m = expr as { $match: JSONType; $cases: [JSONType, JSONType][]; $else: JSONType };
      synth(m.$match, at(ctx, "$match"));
      const arms: Schema[] = [];
      m.$cases.forEach(([, result], i) => arms.push(synth(result, at(ctx, `$cases[${i}][1]`))));
      arms.push(synth(m.$else, at(ctx, "$else")));
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

// Verify an expression against an expected schema, reporting on mismatch.
function check(expr: JSONType, expected: Schema, ctx: CheckContext): void {
  // Un-annotated inline lambdas need contextual typing (later milestone); we
  // can't yet check their bodies against `expected`, so defer silently rather
  // than emit a spurious `any ⊄ (fn)` diagnostic.
  if (nodeKind(expr) === "body" && sigOf(expr as Record<string, JSONType>) === null) return;

  const actual = synth(expr, ctx);
  if (!isSubschema(actual, expected, ctx.defs)) {
    report(ctx, `${describe(actual)} is not assignable to ${describe(expected)}.`, {
      expected,
      actual,
    });
  }
}

function describe(schema: Schema): string {
  return JSON.stringify(schema);
}

// ---------------------------------------------------------------------------
// Section G (minimal) — Signature & module wiring (mirrors callFunction /
// callProgram). Full diagnostics formatting is a later milestone.
// ---------------------------------------------------------------------------

// Check a single function body against its declared signature: build its Γ,
// then check its `$return` against the declared return type. Nested function
// locals are checked recursively in the body's own scope.
function checkFunction(body: Record<string, JSONType>, ctx: CheckContext): void {
  const sig = sigOf(body);
  const env = buildTypeScope(body, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env };
  check(body.$return!, sig?.returns ?? true, at(bctx, "$return"));
  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) checkFunction(val, at(bctx, key));
  }
}

// Public entry, mirroring `callProgram`: lift `$types` into the defs pool, wire
// the module scope (function `$fnType`s eager, constants lazy), then check each
// function body. Returns all accumulated diagnostics.
function checkModule(module: Record<string, JSONType>): Diagnostic[] {
  const defs: Defs = isSchemaObject(module.$types) ? (module.$types as Defs) : {};
  const ctx: CheckContext = { defs, env: EMPTY_ENV, diagnostics: [], path: [] };
  const env = buildTypeScope(withoutTypes(module), null, ctx);
  ctx.env = env;

  for (const key of bindingKeys(withoutTypes(module))) {
    const val = module[key]!;
    if (isBody(val)) {
      checkFunction(val, { ...ctx, env, path: [key] });
    } else {
      // Force top-level constants so their bodies get walked for errors even
      // when nothing references them.
      env.lookupType(key);
    }
  }
  return ctx.diagnostics;
}

// The module minus its reserved `$types` sibling, so the type pool is not
// mistaken for a term binding.
function withoutTypes(module: Record<string, JSONType>): Record<string, JSONType> {
  if (!("$types" in module)) return module;
  const { $types, ...rest } = module;
  void $types;
  return rest;
}

// Synthesize the type of a standalone expression (for the CLI/REPL). Returns
// the inferred schema and any diagnostics gathered.
function checkExpr(expr: JSONType, defs: Defs = {}): { type: Schema; diagnostics: Diagnostic[] } {
  const ctx: CheckContext = { defs, env: EMPTY_ENV, diagnostics: [], path: [] };
  return { type: synth(expr, ctx), diagnostics: ctx.diagnostics };
}

export {
  SchemaKind,
  classifySchema,
  isSubschema,
  valueSatisfies,
  synth,
  check,
  checkFunction,
  checkModule,
  checkExpr,
  buildTypeScope,
  nodeKind,
};
export type { Schema, Defs, Diagnostic, TypeEnv, CheckContext, Sig };
