import type { JSONType } from "../types";

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

type ApMode = { kind: "closed" } | { kind: "open" } | { kind: "map"; schema: Schema };

type FnTypeShape = { params: Schema[]; rest?: Schema; returns: Schema };

type Bound = { v: number; excl: boolean };

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

// Resolve a schema through `$ref`s to the head schema narrowing surgery
// operates on. (Ref identity is intentionally discarded: a narrowed type is a
// fresh intersection, not the declared name.)
function resolveDeep(s: Schema, defs: Defs): Schema {
  let t = s;
  while (classifySchema(t) === SchemaKind.Ref) t = resolveRef(t, defs);
  return t;
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

function itemsSchema(o: Record<string, JSONType>): Schema {
  return "items" in o ? o.items! : true; // omitted items == any
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

function fnShape(o: Record<string, JSONType>): FnTypeShape {
  const ft = asObject(o.$fnType!);
  return {
    params: Array.isArray(ft.params) ? ft.params : [],
    rest: "rest" in ft ? ft.rest : undefined,
    returns: "returns" in ft ? ft.returns! : true,
  };
}

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

export type { Schema, Defs, ApMode, FnTypeShape, Bound };
export {
  SchemaKind,
  isSchemaObject,
  classifySchema,
  asObject,
  refName,
  resolveRef,
  resolveDeep,
  unionArms,
  literalValues,
  deepEqual,
  itemsSchema,
  prefixItems,
  tupleRest,
  apMode,
  properties,
  requiredKeys,
  fnShape,
  valueType,
  typeMatches,
  unionOf,
};
