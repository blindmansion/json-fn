// type-checker-demo.ts — A narrated tour of what src/check.ts can do today
// (sections B & C: schema classification, the subschema check S ⊆ T, and the
// value/schema validator). Run it with:
//
//   bun run scripts/type-checker-demo.ts
//
// Everything here is *already-lowered* JSON: the shorthand gloss in each label
// (e.g. `integer & min(0)`) is just a comment for humans — the checker only
// ever sees the JSON Schema shown beneath it.

import { classifySchema, isSubschema, SchemaKind, valueSatisfies } from "../src/check";
import type { Defs, Schema } from "../src/check";

const j = (v: unknown): string => JSON.stringify(v);

function heading(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

// --- classify --------------------------------------------------------------

function classify(gloss: string, schema: Schema): void {
  const kind = SchemaKind[classifySchema(schema)];
  console.log(`  ${gloss.padEnd(34)} ${j(schema).padEnd(40)} → ${kind}`);
}

// --- subschema (S ⊆ T) -----------------------------------------------------

function sub(gloss: string, subSchema: Schema, supSchema: Schema, why: string, defs?: Defs): void {
  const ok = isSubschema(subSchema, supSchema, defs);
  const mark = ok ? "true " : "false";
  console.log(`\n  ${gloss}`);
  console.log(`      S = ${j(subSchema)}`);
  console.log(`      T = ${j(supSchema)}`);
  console.log(`      S ⊆ T ?  ${mark}   — ${why}`);
}

// --- value validation ------------------------------------------------------

function val(gloss: string, value: unknown, schema: Schema, why: string, defs?: Defs): void {
  const ok = valueSatisfies(value as Schema, schema, defs);
  const mark = ok ? "true " : "false";
  console.log(`\n  ${gloss}`);
  console.log(`      value  = ${j(value)}`);
  console.log(`      schema = ${j(schema)}`);
  console.log(`      valid ?  ${mark}   — ${why}`);
}

// ===========================================================================
// 1. classifySchema — what kind of type is this JSON?
// ===========================================================================

heading("1. classifySchema — bucket a schema into a SchemaKind");
console.log();
classify("any", true);
classify("never", false);
classify("string", { type: "string" });
classify("integer", { type: "integer" });
classify('"active" (literal)', { const: "active" });
classify('"w" | "b"', { enum: ["w", "b"] });
classify("number | null", { type: ["number", "null"] });
classify("string[]", { type: "array", items: { type: "string" } });
classify("[int, int]", {
  type: "array",
  prefixItems: [{ type: "integer" }, { type: "integer" }],
  items: false,
  minItems: 2,
});
classify("{ id: string }", {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
});
classify("Board (named)", { $ref: "#/$defs/Board" });
classify("(Cell) -> boolean", { $fnType: { params: [{ $ref: "#/$defs/Cell" }], returns: { type: "boolean" } } });
classify("hand-written not(...)", { not: { type: "string" } });

// ===========================================================================
// 2. isSubschema — "can a value of type S be used where T is expected?"
//    This is the whole game for typechecking a call f(x): is arg ⊆ param?
// ===========================================================================

heading("2. isSubschema(S, T) — is every S-value also a T-value?");

console.log("\n-- primitives ------------------------------------------------");
sub("integer used where number expected", { type: "integer" }, { type: "number" },
  "every integer is a number");
sub("number used where integer expected", { type: "number" }, { type: "integer" },
  "3.5 is a number but not an integer");

console.log("\n-- literals & enums ------------------------------------------");
sub('the literal "w" where Color is expected', { const: "w" }, { enum: ["w", "b"] },
  '"w" is one of the enum members');
sub('Color where the literal "w" is expected', { enum: ["w", "b"] }, { const: "w" },
  '"b" is a Color but not the literal "w"');
sub("a string where a fixed enum is expected", { type: "string" }, { enum: ["w", "b"] },
  "infinitely many strings can't fit a 2-value set");

console.log("\n-- unions ----------------------------------------------------");
sub("number where (number | null) expected", { type: "number" }, { type: ["number", "null"] },
  "a number fits one arm of the union");
sub("(number | null) where number expected", { type: ["number", "null"] }, { type: "number" },
  "null is not a number, so the whole union doesn't fit");

console.log("\n-- refinements (contracts) -----------------------------------");
sub("(integer & min(5)) where (integer & min(0))", { type: "integer", minimum: 5 }, { type: "integer", minimum: 0 },
  "5..∞ sits inside 0..∞");
sub("(integer & min(0)) where (integer & min(5))", { type: "integer", minimum: 0 }, { type: "integer", minimum: 5 },
  "0..∞ leaks below the required lower bound of 5");
sub("multipleOf(4) where multipleOf(2)", { type: "integer", multipleOf: 4 }, { type: "integer", multipleOf: 2 },
  "every multiple of 4 is a multiple of 2");

console.log("\n-- arrays, tuples, objects -----------------------------------");
sub("integer[] where number[]",
  { type: "array", items: { type: "integer" } },
  { type: "array", items: { type: "number" } },
  "items are covariant: integer ⊆ number");
sub("[int, int] where int[] (tuple ⊆ array)",
  { type: "array", prefixItems: [{ type: "integer" }, { type: "integer" }], items: false, minItems: 2 },
  { type: "array", items: { type: "integer" } },
  "each tuple slot fits the array's element type");
sub("closed {id} where open {id, ...}",
  { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  "a closed object is a special case of the open one");
sub("open {id, ...} where closed {id}",
  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  "the open object may carry extra keys the closed one forbids");

console.log("\n-- function types (variance) ---------------------------------");
sub("(number)->integer where (integer)->number",
  { $fnType: { params: [{ type: "number" }], returns: { type: "integer" } } },
  { $fnType: { params: [{ type: "integer" }], returns: { type: "number" } } },
  "params contravariant (accepts wider), return covariant (gives narrower)");
sub("(integer)->number where (number)->integer",
  { $fnType: { params: [{ type: "integer" }], returns: { type: "number" } } },
  { $fnType: { params: [{ type: "number" }], returns: { type: "integer" } } },
  "it can't accept every number, and may return a non-integer");

console.log("\n-- named & recursive types (via a $defs pool) ----------------");
const defs: Defs = {
  UserId: { type: "string", pattern: "^u_" },
  Tree: {
    type: "object",
    properties: {
      value: { type: "number" },
      children: { type: "array", items: { $ref: "#/$defs/Tree" } },
    },
    required: ["value", "children"],
    additionalProperties: false,
  },
};
sub("UserId where string", { $ref: "#/$defs/UserId" }, { type: "string" },
  "a UserId is a (pattern-refined) string", defs);
sub("string where UserId", { type: "string" }, { $ref: "#/$defs/UserId" },
  "an arbitrary string need not match the ^u_ pattern", defs);
sub("Tree where Tree (recursive, self-referential)", { $ref: "#/$defs/Tree" }, { $ref: "#/$defs/Tree" },
  "the coinductive $ref guard makes this terminate at true", defs);

// ===========================================================================
// 3. valueSatisfies — does a concrete JSON value match a schema?
//    (Same schemas, used as runtime validators — the §6 boundary story.)
// ===========================================================================

heading("3. valueSatisfies(value, schema) — runtime validation");

val("a valid board coordinate", 42, { type: "integer", minimum: 0, maximum: 63 },
  "42 is an integer within 0..63");
val("an out-of-range coordinate", 64, { type: "integer", minimum: 0, maximum: 63 },
  "64 exceeds the maximum of 63");
val("a well-formed user id", "u_123", { type: "string", pattern: "^u_" },
  "matches the ^u_ pattern");
val("a chess cell (piece or empty)", null, { enum: ["K", "Q", "R", null] },
  "null (empty square) is an allowed member");
val("a Move object", { from: 12, to: 28 }, {
  type: "object",
  properties: { from: { type: "integer" }, to: { type: "integer" } },
  required: ["from", "to"],
  additionalProperties: false,
}, "both required integer fields present, no extras");
val("a Move with a stray key", { from: 12, to: 28, promote: "Q" }, {
  type: "object",
  properties: { from: { type: "integer" }, to: { type: "integer" } },
  required: ["from", "to"],
  additionalProperties: false,
}, "the closed object rejects the extra `promote` key");
val("a recursive Tree value", { value: 1, children: [{ value: 2, children: [] }] }, { $ref: "#/$defs/Tree" },
  "validates the whole nested structure against the recursive type", defs);

console.log();
