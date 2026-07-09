/**
 * The `.jfn` type-expression sub-grammar (type-syntax-spec §2–§6, §11). A
 * self-contained parser that never re-enters the term grammar: once the term
 * parser hands control here (after `type Name =`, after a param `:`, or after a
 * funcLit `->`), it stays until a boundary token (`=>`, `,`, `)`, `}`, `]`)
 * hands control back. Output is canonical-fragment JSON Schema — the same shape
 * `typescript/src/check/schema.ts` classifies.
 *
 * Enforcement tier (plan §0.1): the parser validates only what is decidable
 * from local structure — refinements on a *primitive* base. Refinements on a
 * *named* base and all name resolution are the checker's job, so a `$ref` base
 * merely accretes the keyword and defers.
 */

import { TokenCursor, describe } from "./cursor";
import { ParseError } from "./error";
import type { JSONType } from "../types";

// A type is canonical-fragment JSON Schema (extended with `$ref` and the
// distinguished `$fnType` node). Boolean schemas `true`/`false` are `any`/`never`.
export type Schema = JSONType;

// The refinement compatibility matrix (spec §5.3). `on` lists the primitive
// base `type` values a refinement may attach to; `arg` is its literal argument
// shape.
type RefinementSpec = {
  keyword: string;
  on: string[];
  arg: "num" | "str" | "none";
};

const REFINEMENTS: Record<string, RefinementSpec> = {
  min: { keyword: "minimum", on: ["number", "integer"], arg: "num" },
  max: { keyword: "maximum", on: ["number", "integer"], arg: "num" },
  xmin: { keyword: "exclusiveMinimum", on: ["number", "integer"], arg: "num" },
  xmax: { keyword: "exclusiveMaximum", on: ["number", "integer"], arg: "num" },
  multipleOf: { keyword: "multipleOf", on: ["number", "integer"], arg: "num" },
  minLen: { keyword: "minLength", on: ["string"], arg: "num" },
  maxLen: { keyword: "maxLength", on: ["string"], arg: "num" },
  pattern: { keyword: "pattern", on: ["string"], arg: "str" },
  format: { keyword: "format", on: ["string"], arg: "str" },
  minItems: { keyword: "minItems", on: ["array"], arg: "num" },
  maxItems: { keyword: "maxItems", on: ["array"], arg: "num" },
  unique: { keyword: "uniqueItems", on: ["array"], arg: "none" },
};

const PRIMITIVE_KEYWORDS = new Set(["null", "boolean", "number", "integer", "string"]);

export class TypeParser extends TokenCursor {
  /** Parse a full type expression (lowest precedence: union). */
  parseType(): Schema {
    return this.parseUnion();
  }

  // ----- union (spec §4) -----

  private parseUnion(): Schema {
    const arms = [this.parseRefined()];
    while (this.peekType() === "pipe") {
      this.advance();
      arms.push(this.parseRefined());
    }
    if (arms.length === 1) return arms[0]!;
    return normalizeUnion(arms);
  }

  // ----- refinements (spec §5.3) -----

  private parseRefined(): Schema {
    let base = this.parsePostfix();
    while (this.peekType() === "amp") {
      this.advance();
      base = this.applyRefinement(base);
    }
    return base;
  }

  /** Parse one `& kw(arg)` refinement and attach it to `base`. */
  private applyRefinement(base: Schema): Schema {
    const nameTok = this.tokens[this.pos]!;
    const name = this.expectIdent("refinement name");
    const spec = REFINEMENTS[name];
    if (spec === undefined) {
      throw new ParseError(`unknown refinement '${name}'`, nameTok.line, nameTok.col);
    }
    const value = this.parseRefinementArg(spec, name);

    const cat = baseCategory(base);
    // A named base ($ref) is opaque to the parser: attach and let the checker
    // validate against the resolved type (plan §0.1).
    if (cat !== "ref" && (cat === null || !spec.on.includes(cat))) {
      throw new ParseError(
        `${name}(...) is not valid on ${describeBase(base)}`,
        nameTok.line,
        nameTok.col,
      );
    }
    return { ...(base as Record<string, JSONType>), [spec.keyword]: value };
  }

  private parseRefinementArg(spec: RefinementSpec, name: string): JSONType {
    if (spec.arg === "none") {
      if (this.peekType() === "lparen") {
        throw this.err(`refinement '${name}' takes no argument`);
      }
      return true;
    }
    this.expect("lparen", `'(' after refinement '${name}'`);
    const value = this.parseLiteralArg(spec.arg, name);
    this.expect("rparen", `')' after refinement argument`);
    return value;
  }

  private parseLiteralArg(kind: "num" | "str", name: string): JSONType {
    const t = this.peek();
    if (kind === "num") {
      if (t.type === "num") {
        this.advance();
        return t.value;
      }
      // Negative numeric argument: a `minus` immediately followed by a `num`.
      if (t.type === "minus" && this.peek2().type === "num") {
        this.advance();
        const n = this.advance() as { type: "num"; value: number };
        return -n.value;
      }
      throw this.err(`refinement '${name}' expects a number argument`);
    }
    if (t.type === "str") {
      this.advance();
      return t.value;
    }
    throw this.err(`refinement '${name}' expects a string argument`);
  }

  // ----- postfix array suffix (spec §5.1) -----

  private parsePostfix(): Schema {
    let base = this.parseAtom();
    while (this.peekType() === "lbracket") {
      this.advance();
      this.expect("rbracket", "']' to close an array type suffix");
      base = arrayOf(base);
    }
    return base;
  }

  // ----- atoms (spec §2, §3, §5.2, §6) -----

  private parseAtom(): Schema {
    const t = this.peek();
    switch (t.type) {
      case "num":
        this.advance();
        return { const: t.value };
      case "str":
        this.advance();
        return { const: t.value };
      case "lbrace":
        return this.parseObjectType();
      case "lbracket":
        return this.parseTuple();
      case "lparen":
        if (this.looksLikeFnType()) return this.parseFnType();
        this.advance();
        {
          const inner = this.parseType();
          this.expect("rparen", "')' to close a grouped type");
          return inner;
        }
      case "ident":
        this.advance();
        switch (t.value) {
          case "null":
            return { type: "null" };
          case "boolean":
            return { type: "boolean" };
          case "number":
            return { type: "number" };
          case "integer":
            return { type: "integer" };
          case "string":
            return { type: "string" };
          case "any":
            return true;
          case "never":
            return false;
          case "true":
            return { const: true };
          case "false":
            return { const: false };
          default:
            return { $ref: `#/$defs/${t.value}` };
        }
      default:
        throw this.err(`expected a type, found ${describe(t)}`);
    }
  }

  // ----- object types (spec §5.2) -----

  private parseObjectType(): Schema {
    this.expect("lbrace", "'{' to begin an object type");
    // `{}` — closed empty object.
    if (this.peekType() === "rbrace") {
      this.advance();
      return { type: "object", required: [], additionalProperties: false };
    }
    // `{...}` — fully open object.
    if (this.peekType() === "dotdotdot") {
      this.advance();
      this.expect("rbrace", "'}' after '...'");
      return { type: "object" };
    }

    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    let hasFields = false;
    let mapSchema: Schema | undefined;
    let open = false;

    for (;;) {
      if (this.peekType() === "dotdotdot") {
        this.advance();
        open = true;
        this.expect("rbrace", "'}' after '...'");
        break;
      }
      if (this.peekType() === "lbracket") {
        // Map form: `[string]: type`.
        this.advance();
        if (!this.isKeyword("string")) {
          throw this.err("map key type must be 'string' (only string-keyed maps are supported)");
        }
        this.advance();
        this.expect("rbracket", "']' after map key type");
        this.expect("colon", "':' after map key");
        if (mapSchema !== undefined) {
          throw this.err("an object type may declare at most one map ([string]: T) entry");
        }
        mapSchema = this.parseType();
      } else {
        const key = this.parseFieldKey();
        const optional = this.peekType() === "question";
        if (optional) this.advance();
        this.expect("colon", "':' after object field name");
        const fieldType = this.parseType();
        properties[key] = fieldType;
        hasFields = true;
        if (!optional) required.push(key);
      }

      const sep = this.peekType();
      if (sep === "comma") {
        this.advance();
        if (this.peekType() === "rbrace") {
          this.advance();
          break;
        }
      } else if (sep === "rbrace") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or '}' in object type");
      }
    }

    const o: Record<string, JSONType> = { type: "object" };
    if (hasFields) o.properties = properties;
    if (mapSchema !== undefined) {
      if (hasFields) o.required = required;
      o.additionalProperties = mapSchema;
    } else if (open) {
      if (hasFields) o.required = required;
    } else {
      o.required = required;
      o.additionalProperties = false;
    }
    return o;
  }

  private parseFieldKey(): string {
    const t = this.peek();
    if (t.type === "ident" || t.type === "str") {
      this.advance();
      return t.value;
    }
    throw this.err(`expected an object field name, found ${describe(t)}`);
  }

  // ----- tuples (spec §5.1) -----

  private parseTuple(): Schema {
    this.expect("lbracket", "'[' to begin a tuple type");
    if (this.peekType() === "rbracket") {
      this.advance();
      return { type: "array", prefixItems: [], items: false, minItems: 0 };
    }

    const prefixItems: Schema[] = [];
    let restItems: Schema | null = null;
    for (;;) {
      if (this.peekType() === "dotdotdot") {
        this.advance();
        restItems = this.parseRestElement();
        this.expect("rbracket", "']' after tuple rest element");
        break;
      }
      prefixItems.push(this.parseType());
      const sep = this.peekType();
      if (sep === "comma") {
        this.advance();
        if (this.peekType() === "rbracket") {
          this.advance();
          break;
        }
      } else if (sep === "rbracket") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or ']' in tuple type");
      }
    }

    const o: Record<string, JSONType> = { type: "array", prefixItems };
    o.items = restItems ?? false;
    o.minItems = prefixItems.length;
    return o;
  }

  // ----- function types (spec §6) -----

  /** Whether the `(` at the cursor opens a function type: scan to the matching
   * `)` and check for a following `->`. */
  private looksLikeFnType(): boolean {
    let depth = 0;
    let i = this.pos;
    for (;;) {
      const t = this.tokens[i]?.tok;
      if (t === undefined || t.type === "eof") return false;
      if (t.type === "lparen") {
        depth++;
      } else if (t.type === "rparen") {
        depth--;
        if (depth === 0) return this.tokens[i + 1]?.tok.type === "arrow";
      }
      i++;
    }
  }

  private parseFnType(): Schema {
    this.expect("lparen", "'(' to begin a function type");
    const params: Schema[] = [];
    let rest: Schema | undefined;
    if (this.peekType() === "rparen") {
      this.advance();
    } else {
      for (;;) {
        if (this.peekType() === "dotdotdot") {
          this.advance();
          rest = this.parseRestElement();
          this.expect("rparen", "')' after function-type rest parameter");
          break;
        }
        params.push(this.parseType());
        const sep = this.peekType();
        if (sep === "comma") {
          this.advance();
          if (this.peekType() === "rparen") {
            this.advance();
            break;
          }
        } else if (sep === "rparen") {
          this.advance();
          break;
        } else {
          throw this.err("expected ',' or ')' in function-type parameters");
        }
      }
    }
    this.expect("arrow", "'->' in function type");
    const returns = this.parseType();
    const shape: Record<string, JSONType> = { params };
    if (rest !== undefined) shape.rest = rest;
    shape.returns = returns;
    return { $fnType: shape };
  }

  // ----- rest element (`...T[]`) -----

  /** Parse a rest element type `T[]` and unwrap one array layer to its element
   * schema (plan §3.4 / §11): `...number[]` ⇒ `number`, `...number[][]` ⇒
   * `number[]`. */
  private parseRestElement(): Schema {
    const arr = this.parseType();
    const inner = arrayElement(arr);
    if (inner === undefined) {
      throw this.err("a rest element must be written with the array suffix, e.g. ...T[]");
    }
    return inner;
  }
}

// ----- schema helpers -----

function isObj(s: Schema): s is Record<string, JSONType> {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

/** Wrap `inner` as an array type, omitting `items` when the element is `any`. */
function arrayOf(inner: Schema): Schema {
  if (inner === true) return { type: "array" };
  return { type: "array", items: inner };
}

/** If `s` is a plain (non-tuple) array schema, return its element schema
 * (`any` when `items` is omitted); otherwise `undefined`. Exported so param
 * parsing can unwrap a rest annotation `...xs: T[]` the same way. */
export function arrayElement(s: Schema): Schema | undefined {
  if (!isObj(s) || s.type !== "array" || "prefixItems" in s) return undefined;
  return "items" in s ? s.items! : true;
}

/** The refinement-relevant category of a base schema: a primitive `type`
 * string, `"array"`, `"ref"` for a named type, or `null` when nothing may
 * attach. */
function baseCategory(s: Schema): string | null {
  if (!isObj(s)) return null;
  if ("$ref" in s) return "ref";
  const t = s.type;
  if (typeof t === "string" && (PRIMITIVE_KEYWORDS.has(t) || t === "array")) return t;
  return null;
}

function describeBase(s: Schema): string {
  if (s === true) return "any";
  if (s === false) return "never";
  if (isObj(s)) {
    if ("$fnType" in s) return "a function type";
    if ("const" in s) return "a literal";
    if ("enum" in s) return "an enum";
    if (typeof s.type === "string") return s.type;
    if (Array.isArray(s.type)) return "a union";
  }
  return "this type";
}

// ----- union normalization (spec §4, plan §3.2) -----

/** The three-rule cascade. `arms` is left-to-right, already flattened at the
 * grouping level by `parseUnion`; nested unions from `( … )` groups are
 * flattened here. */
function normalizeUnion(rawArms: Schema[]): Schema {
  const arms: Schema[] = [];
  for (const a of rawArms) flattenArm(a, arms);

  // Rule 1: every arm is a literal (const/enum) or `null` → one `enum`.
  if (arms.every(isLiteralish) && arms.some(isLiteral)) {
    return enumOf(collectLiteralValues(arms));
  }
  // Rule 2: every arm is a bare primitive (incl. `null`) → one `type` array.
  if (arms.every(isBarePrimitive)) {
    return typeArrayOf(arms.map(primitiveName));
  }
  // Rule 3: `anyOf`, merging runs of literals/primitives.
  return anyOfOf(arms);
}

/** Flatten a grouped `anyOf` / `type`-array arm into individual arms so the
 * cascade sees a flat list (an `enum` arm stays whole — it is one literal arm). */
function flattenArm(s: Schema, out: Schema[]): void {
  if (isObj(s) && Array.isArray(s.anyOf)) {
    for (const a of s.anyOf as Schema[]) flattenArm(a, out);
  } else if (isObj(s) && Array.isArray(s.type)) {
    for (const t of s.type as string[]) out.push({ type: t });
  } else {
    out.push(s);
  }
}

function isNullType(s: Schema): boolean {
  return isObj(s) && s.type === "null";
}

function isLiteral(s: Schema): boolean {
  return isObj(s) && ("const" in s || "enum" in s);
}

// Literal-ish: a literal, or `null` (which joins an enum as the value `null`).
function isLiteralish(s: Schema): boolean {
  return isLiteral(s) || isNullType(s);
}

function isBarePrimitive(s: Schema): boolean {
  if (!isObj(s)) return false;
  const keys = Object.keys(s);
  return keys.length === 1 && typeof s.type === "string" && PRIMITIVE_KEYWORDS.has(s.type);
}

function primitiveName(s: Schema): string {
  return (s as Record<string, JSONType>).type as string;
}

function literalValuesOf(s: Schema): JSONType[] {
  const o = s as Record<string, JSONType>;
  if ("const" in o) return [o.const!];
  if ("enum" in o) return o.enum as JSONType[];
  if (isNullType(s)) return [null];
  return [];
}

function collectLiteralValues(arms: Schema[]): JSONType[] {
  const values: JSONType[] = [];
  for (const arm of arms) {
    for (const v of literalValuesOf(arm)) pushUnique(values, v);
  }
  return values;
}

/** An `enum` schema, collapsing a single value to its canonical `const`/`null`. */
function enumOf(values: JSONType[]): Schema {
  if (values.length === 1) {
    return values[0] === null ? { type: "null" } : { const: values[0]! };
  }
  return { enum: values };
}

function typeArrayOf(names: string[]): Schema {
  const uniq: string[] = [];
  for (const n of names) if (!uniq.includes(n)) uniq.push(n);
  if (uniq.length === 1) return { type: uniq[0]! };
  return { type: uniq };
}

/** Build an `anyOf`, merging consecutive literal arms into one `enum` arm and
 * consecutive primitive arms into one `type`-array arm; `null` joins whichever
 * run is pending. Dedupes the resulting arms and unwraps a lone arm. */
function anyOfOf(arms: Schema[]): Schema {
  type Pending = { kind: "lit"; values: JSONType[] } | { kind: "prim"; names: string[] } | null;
  const out: Schema[] = [];
  let pending: Pending = null;

  const flush = (): void => {
    if (pending === null) return;
    if (pending.kind === "lit") pushUniqueArm(out, enumOf(pending.values));
    else pushUniqueArm(out, typeArrayOf(pending.names));
    pending = null;
  };

  for (const arm of arms) {
    if (isLiteral(arm)) {
      if (pending?.kind !== "lit") {
        flush();
        pending = { kind: "lit", values: [] };
      }
      for (const v of literalValuesOf(arm)) pushUnique(pending.values, v);
    } else if (isBarePrimitive(arm)) {
      if (pending?.kind !== "prim") {
        flush();
        pending = { kind: "prim", names: [] };
      }
      if (!pending.names.includes(primitiveName(arm))) pending.names.push(primitiveName(arm));
    } else if (isNullType(arm)) {
      if (pending?.kind === "lit") pushUnique(pending.values, null);
      else if (pending?.kind === "prim") {
        if (!pending.names.includes("null")) pending.names.push("null");
      } else {
        flush();
        pushUniqueArm(out, { type: "null" });
      }
    } else {
      flush();
      pushUniqueArm(out, arm);
    }
  }
  flush();

  if (out.length === 1) return out[0]!;
  return { anyOf: out };
}

function pushUnique(values: JSONType[], v: JSONType): void {
  if (!values.some((existing) => deepEqual(existing, v))) values.push(v);
}

function pushUniqueArm(arms: Schema[], arm: Schema): void {
  if (!arms.some((existing) => deepEqual(existing, arm))) arms.push(arm);
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
