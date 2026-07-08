// Bidirectional: `synth` infers a schema for an expression; `check` verifies an
// expression against an expected schema. This milestone is *synth-first* — it
// types a fully-`$sig`-annotated module. Contextual typing of un-annotated
// inline lambdas and the polymorphic builtin layer arrive in a later milestone;
// until then an unknown callee or un-annotated lambda degrades to `any`.

import type { JSONType } from "../types";
import { isSchemaObject } from "./schema";

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

// The bare `$var` name a node refers to, or null when it isn't a bare var.
function asVarName(node: JSONType): string | null {
  return nodeKind(node) === "var" ? (node as { $var: string }).$var : null;
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

export { nodeKind, asVarName, litOf };
