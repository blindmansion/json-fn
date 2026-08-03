/**
 * Canonical-tree normalization: the shorthand printer's round-trip property is
 *
 *   parse(print(node)) = normalize(node)
 *
 * rather than exact identity for every accepted canonical tree. The `.jfn`
 * surface has no `raw` keyword — generic `$raw` payloads print as ordinary
 * strict-JSON data and the parser reconstructs the boundary wherever it is
 * semantically required — so structurally redundant `$raw` spellings cannot
 * round-trip exactly. This module makes the resulting normal form explicit:
 *
 * - a `$raw` wrapper around a scalar or a payload containing no `$`-prefixed
 *   key anywhere is semantically redundant and is removed;
 * - a `$raw` boundary inside a static literal parent is hoisted to the
 *   maximal static subtree (matching the parser's maximal raw inference);
 * - wrappers whose payloads contain `$`-prefixed keys (expression-shaped
 *   data, reserved keys, literal `$comment` data, generated code-as-value)
 *   are retained, payload untouched;
 * - the raw third argument of a printable annotated `handle` call is
 *   syntax-owned metadata and is retained exactly (the contextual
 *   `returns <type>` surface reconstructs it); and
 * - `$comment` keys on expression syntax are dropped, mirroring the printer
 *   (comments have no shorthand surface form yet; `$comment` keys inside raw
 *   payloads are data and survive).
 *
 * Normalization is context-sensitive program normalization: it distinguishes
 * expression syntax, syntax-owned metadata (type schemas, signatures), and
 * quoted guest data. It must never be applied to arbitrary guest values.
 */

import type { JSONType } from "../types";
import { setOwnProperty } from "../own-properties";
import { assertStructuralDepth } from "../structural-depth";

/** Normalize a canonical module: type pools and signatures are syntax-owned
 * metadata and pass through; binding values normalize as expressions. */
export function normalizeModule(module: JSONType): JSONType {
  assertStructuralDepth(module);
  if (!isPlainObject(module)) return module;
  const result: Record<string, JSONType> = {};
  for (const [key, value] of Object.entries(module)) {
    if (key === "$comment") continue;
    if (key === "$types") {
      setOwnProperty(result, key, value);
      continue;
    }
    setOwnProperty(result, key, normalize(value));
  }
  return result;
}

/** Normalize one canonical expression tree. */
export function normalizeExpression(node: JSONType): JSONType {
  assertStructuralDepth(node);
  return normalize(node);
}

function normalize(node: JSONType): JSONType {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return hoistArrayLiteral(node.map(normalize));

  // Mirror the printer's expression dispatch. Structure slots (binding maps,
  // argument lists, arm pairs, parameter records, schemas) are canonical
  // syntax, never literal collections, and are therefore rebuilt rather than
  // hoisted; only their expression-valued slots normalize recursively.
  if ("$let" in node || "$in" in node) {
    const bindings = node.$let;
    const rebuilt: Record<string, JSONType> = {};
    if (isPlainObject(bindings)) {
      for (const [name, value] of Object.entries(bindings)) {
        setOwnProperty(rebuilt, name, normalize(value));
      }
    }
    return { $let: rebuilt, $in: normalize(node.$in ?? null) };
  }
  if ("$call" in node) return normalizeCall(node);
  if ("$fn" in node) {
    const fn = node.$fn;
    return { $fn: fn !== null && typeof fn === "object" ? normalize(fn) : fn };
  }
  if ("$var" in node) return { $var: node.$var ?? null };
  if ("$get" in node && "$from" in node) {
    return { $get: normalizeGet(node.$get ?? null), $from: normalize(node.$from ?? null) };
  }
  if ("$if" in node) {
    return {
      $if: normalize(node.$if ?? null),
      $then: normalize(node.$then ?? null),
      $else: normalize(node.$else ?? null),
    };
  }
  if ("$cond" in node) {
    const rebuilt: Record<string, JSONType> = { $cond: normalizeArms(node.$cond ?? null) };
    if ("$else" in node) rebuilt.$else = normalize(node.$else ?? null);
    return rebuilt;
  }
  if ("$match" in node) {
    return {
      $match: normalize(node.$match ?? null),
      $cases: normalizeArms(node.$cases ?? null),
      $else: normalize(node.$else ?? null),
    };
  }
  if ("$and" in node) return { $and: normalizeList(node.$and ?? null) };
  if ("$or" in node) return { $or: normalizeList(node.$or ?? null) };
  if ("$nonnull" in node) return { $nonnull: normalize(node.$nonnull ?? null) };
  if ("$as" in node && "$type" in node) {
    return { $as: normalize(node.$as ?? null), $type: node.$type ?? null };
  }
  if ("$raw" in node) return normalizeRaw(node.$raw ?? null);
  if ("$return" in node) {
    const rebuilt: Record<string, JSONType> = {};
    if ("$sig" in node) rebuilt.$sig = node.$sig ?? null;
    if ("$params" in node) rebuilt.$params = normalizeParams(node.$params ?? null);
    rebuilt.$return = normalize(node.$return ?? null);
    return rebuilt;
  }
  if (Object.keys(node).some((key) => key !== "$comment" && key.startsWith("$"))) {
    // Unknown reserved-key shapes are not printable; pass them through.
    return node;
  }
  return normalizeDataObject(node);
}

/** A redundant `$raw` wrapper unwraps to its payload; a required one is kept
 * with the payload untouched (payload interiors are data, not syntax). A
 * string `$comment` sibling is tolerated by the evaluator and dropped here,
 * mirroring the printer. */
function normalizeRaw(payload: JSONType): JSONType {
  if (rawWrapperIsRedundant(payload)) return payload;
  return { $raw: payload };
}

function rawWrapperIsRedundant(payload: JSONType): boolean {
  return isPlainJsonData(payload);
}

function normalizeCall(node: { [k: string]: JSONType }): JSONType {
  const head = node.$call ?? null;
  const args = node.$args;
  if (isPrintableHandleSugar(head, args)) {
    const [task, clauses, annotation] = args as [JSONType, JSONType, JSONType?];
    // The clause record after `with` reparses in the handler-record context:
    // no raw inference, no hoisting. Clause values are ordinary expressions.
    const record: Record<string, JSONType> = {};
    for (const [name, value] of Object.entries(clauses as { [k: string]: JSONType })) {
      if (name === "$comment") continue;
      setOwnProperty(record, name, normalize(value));
    }
    const rebuiltArgs: JSONType[] = [normalize(task), record];
    if (annotation !== undefined) {
      // Syntax-owned metadata: the annotated-handle result schema keeps its
      // exact `$raw` boundary regardless of payload shape.
      rebuiltArgs.push({ $raw: (annotation as { [k: string]: JSONType }).$raw ?? null });
    }
    return { $call: "handle", $args: rebuiltArgs };
  }
  return {
    $call: head !== null && typeof head === "object" ? normalize(head) : head,
    $args: normalizeList(args ?? null),
  };
}

/** Mirror of the printer's contextual-handle condition: only these calls
 * print as `handle … with { … }`, whose record reparses without inference. */
function isPrintableHandleSugar(head: JSONType, args: JSONType | undefined): boolean {
  if (head !== "handle" || !Array.isArray(args)) return false;
  if (args.length !== 2 && args.length !== 3) return false;
  const clauses = args[1]!;
  if (!isPlainObject(clauses) || Object.keys(clauses).some((k) => k.startsWith("$"))) return false;
  if (args.length === 3) {
    const annotation = args[2]!;
    if (!isPlainObject(annotation) || !("$raw" in annotation)) return false;
  }
  return true;
}

function normalizeList(values: JSONType): JSONType[] {
  if (!Array.isArray(values)) return [];
  return values.map(normalize);
}

function normalizeArms(pairs: JSONType): JSONType {
  if (!Array.isArray(pairs)) return pairs;
  return pairs.map((pair) =>
    Array.isArray(pair) && pair.length === 2 ? [normalize(pair[0]!), normalize(pair[1]!)] : pair,
  );
}

/** `$get` values: a scalar key or a folded path array of scalar segments;
 * object/array segments are computed-key expressions. */
function normalizeGet(get: JSONType): JSONType {
  if (Array.isArray(get)) {
    return get.map((seg) => (seg !== null && typeof seg === "object" ? normalize(seg) : seg));
  }
  if (get !== null && typeof get === "object") return normalize(get);
  return get;
}

function normalizeParams(params: JSONType): JSONType {
  if (!Array.isArray(params)) return params;
  return params.map((param) => {
    if (!isPlainObject(param)) return param;
    if ("$default" in param) return { ...param, $default: normalize(param.$default ?? null) };
    if ("$fields" in param && Array.isArray(param.$fields)) {
      return {
        $fields: param.$fields.map((field) =>
          isPlainObject(field) && "$default" in field
            ? { ...field, $default: normalize(field.$default ?? null) }
            : field,
        ),
      };
    }
    return param;
  });
}

function normalizeDataObject(node: { [k: string]: JSONType }): JSONType {
  const result: Record<string, JSONType> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$comment") continue;
    setOwnProperty(result, key, normalize(value));
  }
  return hoistObjectLiteral(result);
}

// ----- maximal raw hoisting (mirror of parser raw inference) -----

/** Hoist raw boundaries through a normalized array literal: when every element
 * is static (plain JSON data or a raw wrapper) and at least one is a wrapper,
 * the whole array becomes one `$raw` payload. */
function hoistArrayLiteral(values: JSONType[]): JSONType {
  let requiresRaw = false;
  for (const value of values) {
    const kind = classifyStaticChild(value);
    if (kind === "dynamic") return values;
    if (kind === "wrapper") requiresRaw = true;
  }
  if (!requiresRaw) return values;
  return { $raw: values.map(unwrapStaticChild) };
}

/** Object-literal counterpart of `hoistArrayLiteral`. */
function hoistObjectLiteral(map: Record<string, JSONType>): JSONType {
  let requiresRaw = false;
  for (const value of Object.values(map)) {
    const kind = classifyStaticChild(value);
    if (kind === "dynamic") return map;
    if (kind === "wrapper") requiresRaw = true;
  }
  if (!requiresRaw) return map;
  const payload: Record<string, JSONType> = {};
  for (const [key, value] of Object.entries(map)) {
    setOwnProperty(payload, key, unwrapStaticChild(value));
  }
  return { $raw: payload };
}

type StaticChildKind = "plain" | "wrapper" | "dynamic";

function classifyStaticChild(value: JSONType): StaticChildKind {
  if (value === null || typeof value !== "object") return "plain";
  if (isRawWrapper(value)) return "wrapper";
  return isPlainJsonData(value) ? "plain" : "dynamic";
}

function unwrapStaticChild(value: JSONType): JSONType {
  return isRawWrapper(value) ? ((value as { $raw: JSONType }).$raw ?? null) : value;
}

function isRawWrapper(value: JSONType): boolean {
  return isPlainObject(value) && "$raw" in value;
}

// Positive-result cache: plain-ness of a composite is stable for the
// immutable canonical trees normalization operates on.
const plainJsonComposites = new WeakSet<object>();

/** Whether `value` is pure JSON data: no object anywhere in the tree carries a
 * `$`-prefixed key. Such a subtree is static literal syntax to the parser and
 * needs no `$raw` boundary. Iterative walk with memoized positives. */
function isPlainJsonData(value: JSONType): boolean {
  if (value === null || typeof value !== "object") return true;
  if (plainJsonComposites.has(value)) return true;
  const composites: object[] = [];
  const stack: JSONType[] = [value];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (plainJsonComposites.has(current)) continue;
    composites.push(current);
    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
    } else {
      for (const [key, child] of Object.entries(current)) {
        if (key.startsWith("$")) return false;
        stack.push(child);
      }
    }
  }
  for (const composite of composites) plainJsonComposites.add(composite);
  return true;
}

function isPlainObject(value: unknown): value is { [k: string]: JSONType } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
