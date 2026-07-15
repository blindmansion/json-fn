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

// Collect the names of every `$ref` reachable *within a schema* (a type
// expression), structurally walking the tractable fragment. Powers the
// declare-before-use pass that turns a dangling `$ref` into a hard error rather
// than a silent resolve-to-top (`resolveRef`). Deliberately does *not* descend
// into `const`/`enum` literal payloads — those are data values, so a literal
// object that happens to carry a `$ref`-shaped key is not mistaken for a type
// reference. Opaque (out-of-fragment) schemas are skipped too: the checker
// treats them as `any`, so their contents are never resolved.
function collectSchemaRefs(s: Schema, into: Set<string>): void {
  if (!isSchemaObject(s)) return;
  switch (classifySchema(s)) {
    case SchemaKind.Ref:
      into.add(refName(s));
      return;
    case SchemaKind.FnType: {
      const { params, rest, returns } = fnShape(s);
      for (const p of params) collectSchemaRefs(p, into);
      if (rest !== undefined) collectSchemaRefs(rest, into);
      collectSchemaRefs(returns, into);
      return;
    }
    case SchemaKind.Union: {
      const arms = unionArms(s);
      if (arms !== null) for (const a of arms) collectSchemaRefs(a, into);
      return;
    }
    case SchemaKind.Array:
      collectSchemaRefs(itemsSchema(s), into);
      return;
    case SchemaKind.Tuple: {
      for (const p of prefixItems(s)) collectSchemaRefs(p, into);
      const rest = tupleRest(s);
      if (rest !== null) collectSchemaRefs(rest, into);
      return;
    }
    case SchemaKind.Object: {
      for (const v of Object.values(properties(s))) collectSchemaRefs(v, into);
      const mode = apMode(s);
      if (mode.kind === "map") collectSchemaRefs(mode.schema, into);
      return;
    }
    default:
      return; // Primitive / Const / Enum / Any / Never / Opaque carry no type refs
  }
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

// Widen a synthesized scalar literal to its primitive category when it
// participates in a join. Literal schemas remain precise everywhere else
// (notably discriminants and narrowing facts).
function widenLiteral(s: Schema): Schema {
  if (classifySchema(s) !== SchemaKind.Const) return s;
  const value = asObject(s).const;
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return { type: typeof value };
  }
  return s;
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

// Project the type of `target[key]` out of the target's schema. Handles the
// common static cases (object property by literal string key, array/tuple
// element by literal number key, static folded paths); anything dynamic or
// out-of-fragment degrades to `any`. A pure schema operation (no checker
// context) so both `synth`'s `$get` case and flow narrowing can share it.
function projectField(target: Schema, key: JSONType, defs: Defs): Schema {
  const t = resolveDeep(target, defs);
  if (t === true) return true;

  // A union projects the field off every arm and joins the results: reading a
  // shared field off `A | B` yields `A[key] | B[key]` (so a tagged union's
  // common discriminant projects to its literal union, `"a" | "b"`), and
  // indexing a union of arrays/tuples joins their elements. An arm that can't
  // carry the field (a non-object under a string key, etc.) projects to `any`,
  // which the join then absorbs — matching the pre-union degrade-to-`any`.
  const arms = unionArms(t);
  if (arms !== null) return unionOf(arms.map((a) => projectField(a, key, defs)));

  if (typeof key === "string") {
    if (classifySchema(t) !== SchemaKind.Object) return true;
    const o = asObject(t);
    const props = properties(o);
    if (key in props) {
      // An optional field (declared in `properties` but absent from `required`)
      // may be missing at runtime, where the evaluator yields null. Reflect the
      // absence as `T | null` so readers must account for it.
      const propType = props[key]!;
      return requiredKeys(o).includes(key) ? propType : unionOf([propType, { type: "null" }]);
    }
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
    for (const seg of key) cur = projectField(cur, seg, defs);
    return cur;
  }

  return true; // dynamic key
}

// Would reading the literal string `key` off `target` be a *guaranteed* miss —
// a closed object (or a union whose every arm is one) that never declares it?
// Such an access can only ever yield null at runtime, so it masks a typo rather
// than reading a real field (Priority-1 §2). Everything else stays permissive,
// matching `projectField`'s degrade behavior: an `any` target, a present (even
// optional) key, and open / map / non-object arms are all *not* guaranteed
// misses. A union is a guaranteed miss only when **every** arm is — if one arm
// can supply the key, the read is the legitimate partial-arm / tagged-union
// pattern that honestly projects to `T | null`.
function isClosedMissingKey(target: Schema, key: string, defs: Defs): boolean {
  const t = resolveDeep(target, defs);
  if (t === true || t === false) return false;
  const arms = unionArms(t);
  if (arms !== null) return arms.length > 0 && arms.every((a) => isClosedMissingKey(a, key, defs));
  if (classifySchema(t) !== SchemaKind.Object) return false;
  const o = asObject(t);
  if (key in properties(o)) return false;
  return apMode(o).kind === "closed";
}

// Could a value of `keyType` fall in the index/key category `cat` ("integer"
// for array/tuple positions, "string" for object/map keys)? `any` matches
// anything, `never` nothing; a union matches if any arm does. Const/enum use the
// integer-aware `typeMatches` so `2.5` does *not* count as an integer. Shared by
// the computed-index projection below and the checker's index-key check.
function keyCouldBe(keyType: Schema, cat: "integer" | "string", defs: Defs): boolean {
  const t = resolveDeep(keyType, defs);
  if (t === true) return true;
  if (t === false) return false;
  const arms = unionArms(t);
  if (arms !== null) return arms.some((a) => keyCouldBe(a, cat, defs));
  switch (classifySchema(t)) {
    case SchemaKind.Primitive: {
      const ty = asObject(t).type as string;
      return cat === "integer" ? ty === "integer" || ty === "number" : ty === cat;
    }
    case SchemaKind.Const:
      return typeMatches(asObject(t).const!, cat);
    case SchemaKind.Enum:
      return literalValues(t).some((v) => typeMatches(v, cat));
    default:
      return false;
  }
}

// Project `target[key]` when `key` is a *computed* expression, keyed on the
// key's inferred type rather than a concrete value (the counterpart to
// `projectField`, which needs a literal key). An integer-typed key projects an
// array's `items` / a tuple's element union; a string-typed key projects a
// map's `additionalProperties` / a closed object's property union. Mirrors
// `projectField`'s union decomposition and its `T | null` conventions. Anything
// unprojectable (a non-container target, a key that can't be the right
// category) degrades to `any`, matching the pre-projection behavior.
function projectComputed(target: Schema, keyType: Schema, defs: Defs): Schema {
  const t = resolveDeep(target, defs);
  if (t === true) return true;

  const arms = unionArms(t);
  if (arms !== null) return unionOf(arms.map((a) => projectComputed(a, keyType, defs)));

  const k = classifySchema(t);
  const results: Schema[] = [];

  if (keyCouldBe(keyType, "integer", defs)) {
    if (k === SchemaKind.Array) results.push(itemsSchema(asObject(t)));
    else if (k === SchemaKind.Tuple) {
      const o = asObject(t);
      // A computed index may land on any declared slot or run past the end
      // (where the evaluator yields null), so join every element with `null`.
      results.push(...prefixItems(o), tupleRest(o) ?? { type: "null" }, { type: "null" });
    }
  }
  if (keyCouldBe(keyType, "string", defs) && k === SchemaKind.Object) {
    const o = asObject(t);
    const mode = apMode(o);
    const propVals = Object.values(properties(o));
    if (mode.kind === "map") results.push(...propVals, mode.schema);
    else if (mode.kind === "open") results.push(true);
    // A computed key on a closed object may hit any declared property or miss
    // entirely (null at runtime).
    else results.push(...propVals, { type: "null" });
  }

  if (results.length === 0) return true;
  return unionOf(results);
}

// The value type carried by an object's entries: the union of its declared
// property value types plus (for a map) its `additionalProperties` value
// schema. An open object — or `any` — yields `any`, degrading a `values`/
// `entries` result to its bare floor; a closed object with no properties yields
// `never` (it has no values). Unions distribute per arm. Counterpart to
// `pairValueType`, letting `values`/`entries` project the map value into their
// array element the way `fromEntries` projects it back into a map.
function objectValueType(obj: Schema, defs: Defs): Schema {
  const t = resolveDeep(obj, defs);
  if (t === true) return true;
  const arms = unionArms(t);
  if (arms !== null) return unionOf(arms.map((a) => objectValueType(a, defs)));
  if (classifySchema(t) !== SchemaKind.Object) return true;
  const o = asObject(t);
  const propVals = Object.values(properties(o));
  const mode = apMode(o);
  if (mode.kind === "open") return true;
  if (mode.kind === "map") return unionOf([...propVals, mode.schema]);
  return unionOf(propVals); // closed: exactly the declared property values
}

// One object schema's view of a key `k`: the schema a value at `k` would carry,
// and whether the key is guaranteed present. `null` means `k` can never occur
// (a closed object that doesn't declare it). A named property uses its declared
// type + required-ness; an undeclared key falls to the additional-properties
// rule (open → `any`, map → the map's value schema), never guaranteed present.
function keyView(
  o: Record<string, JSONType>,
  k: string,
): { schema: Schema; required: boolean } | null {
  const props = properties(o);
  if (k in props) return { schema: props[k]!, required: requiredKeys(o).includes(k) };
  const mode = apMode(o);
  if (mode.kind === "closed") return null;
  if (mode.kind === "open") return { schema: true, required: false };
  return { schema: mode.schema, required: false };
}

// The additional-properties rule of `{ ...a, ...b }` for keys named in neither
// side: a stray key takes `b`'s value if `b` supplies one, else `a`'s. `b` open
// makes the result open (arbitrary `any` keys); `b` map joins with `a`'s own
// extra-key rule (open wins, else the map value schemas union, else just `b`'s);
// `b` closed leaves `a`'s rule untouched.
function mergeApMode(a: Record<string, JSONType>, b: Record<string, JSONType>): ApMode {
  const am = apMode(a);
  const bm = apMode(b);
  if (bm.kind === "open") return { kind: "open" };
  if (bm.kind === "map") {
    if (am.kind === "open") return { kind: "open" };
    if (am.kind === "map") return { kind: "map", schema: unionOf([am.schema, bm.schema]) };
    return { kind: "map", schema: bm.schema };
  }
  return am; // b closed: inherit a's rule
}

// Structural merge of two *object* schemas, modeling the `merge` builtin's
// shallow spread `{ ...a, ...b }` (b wins on conflict) at the type level. For
// each named key: b guarantees it (required) → b's type; b may supply it
// (optional / via b's extra-key rule) → the union of b's and a's contributions,
// required only if a guarantees a fallback. Extra keys follow `mergeApMode`.
function mergeObjects(a: Record<string, JSONType>, b: Record<string, JSONType>): Schema {
  const keys = new Set([...Object.keys(properties(a)), ...Object.keys(properties(b))]);
  const props: Record<string, Schema> = {};
  const required: string[] = [];
  for (const k of keys) {
    const av = keyView(a, k);
    const bv = keyView(b, k);
    if (bv !== null && bv.required) {
      props[k] = bv.schema; // b definitely wins
      required.push(k);
      continue;
    }
    // b doesn't guarantee k: the value is b's when present, else a's.
    const parts: Schema[] = [];
    if (bv !== null) parts.push(bv.schema);
    if (av !== null) parts.push(av.schema);
    if (parts.length === 0) continue; // neither side can carry k
    props[k] = unionOf(parts);
    if (av !== null && av.required) required.push(k); // only a can guarantee it
  }

  const out: Record<string, JSONType> = { type: "object", properties: props };
  if (required.length > 0) out.required = required;
  const mode = mergeApMode(a, b);
  if (mode.kind === "closed") out.additionalProperties = false;
  else if (mode.kind === "map") out.additionalProperties = mode.schema;
  // open: leave additionalProperties unset (open-by-default).
  return out;
}

// Merge two schemas as `merge`'s shallow spread would (b wins). Unions
// distribute (a per-arm join, mirroring `projectField`); a non-object side (or
// `any`) can't be structurally merged, so the result degrades to `any` / a bare
// object floor — matching the pre-structural behavior. Ref identity is dropped
// (the result is a fresh structural type), like the other schema surgeries.
function mergeSchemas(a: Schema, b: Schema, defs: Defs): Schema {
  const ra = resolveDeep(a, defs);
  const rb = resolveDeep(b, defs);
  if (ra === true || rb === true) return true;

  const aArms = unionArms(ra);
  if (aArms !== null) return unionOf(aArms.map((arm) => mergeSchemas(arm, rb, defs)));
  const bArms = unionArms(rb);
  if (bArms !== null) return unionOf(bArms.map((arm) => mergeSchemas(ra, arm, defs)));

  if (classifySchema(ra) !== SchemaKind.Object || classifySchema(rb) !== SchemaKind.Object) {
    return { type: "object" }; // non-object operand: fall back to the loose floor
  }
  return mergeObjects(asObject(ra), asObject(rb));
}

// Build a union schema from branch/arm types, flattening + deduping. Kept
// deliberately simple (an `anyOf`, which `subsumes` handles); the shorthand
// printer owns the §2.3 enum/type-array canonicalization.
function unionOf(schemas: Schema[]): Schema {
  const arms: Schema[] = [];
  const add = (s: Schema): boolean => {
    if (s === true) return true; // any absorbs
    if (s === false) return false; // never drops out
    if (isSchemaObject(s) && Array.isArray(s.anyOf)) {
      for (const nested of s.anyOf as Schema[]) {
        if (add(nested)) return true;
      }
      return false;
    }
    if (!arms.some((existing) => deepEqual(existing, s))) arms.push(s);
    return false;
  };
  for (const s of schemas) {
    if (add(s)) return true;
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
  collectSchemaRefs,
  unionArms,
  literalValues,
  widenLiteral,
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
  projectField,
  projectComputed,
  objectValueType,
  isClosedMissingKey,
  keyCouldBe,
  mergeSchemas,
};
