// Bidirectional: `synth` infers a schema for an expression; `check` verifies an
// expression against an expected schema. This milestone is *synth-first* — it
// types a fully-`$sig`-annotated module. Contextual typing of un-annotated
// inline lambdas and the polymorphic builtin layer arrive in a later milestone;
// until then an unknown callee or un-annotated lambda degrades to `any`.

import type { JSONType } from "../types";
import { isSchemaObject } from "../schema/schema.ts";

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
  | "cast"
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
  if ("$cast" in o) return "cast";
  if ("$raw" in o) return "raw";
  return "object";
}

// The bare `$var` name a node refers to, or null when it isn't a bare var.
function asVarName(node: JSONType): string | null {
  return nodeKind(node) === "var" ? (node as { $var: string }).$var : null;
}

// The canonical dot-joined path a node denotes when it is a *static access
// path* — a bare `$var`, or a chain of literal-string `$get`s rooted at one
// (§5.5 M3). `move.from`, `x.tag`, `x.a.b`. Returns null for anything dynamic
// (a computed key, a numeric index, a non-var root). A single-segment path
// serializes to the plain var name, so it is key-compatible with the M1/M2
// bare-var narrowings on `ctx.narrowings`.
function asPath(node: JSONType): string | null {
  if (nodeKind(node) === "var") return (node as { $var: string }).$var;
  if (nodeKind(node) === "get") {
    const o = node as { $get: JSONType; $from: JSONType };
    const base = asPath(o.$from);
    if (base === null) return null;
    if (typeof o.$get === "string") return `${base}.${o.$get}`;
    if (Array.isArray(o.$get) && o.$get.every((k) => typeof k === "string")) {
      return [base, ...(o.$get as string[])].join(".");
    }
    return null;
  }
  return null;
}

// A literal JSON value a node denotes (scalar node, or a scalar `$raw`
// payload), boxed so a literal `null` is distinguishable from "not a literal".
function litOf(node: JSONType): { v: JSONType } | null {
  if (nodeKind(node) === "scalar") return { v: node };
  if (isSchemaObject(node) && "$raw" in node) {
    const raw = node.$raw!;
    if (raw === null || typeof raw !== "object") return { v: raw };
  }
  return null;
}

export { nodeKind, asVarName, asPath, litOf };
