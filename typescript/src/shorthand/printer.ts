/**
 * The raise direction of the `.jfn` surface: canonical json-fn JSON -> shorthand
 * source text. This is the inverse of `parser.ts`, but with two responsibilities
 * the parser does not have:
 *
 *   1. **Canonical spelling.** Several source spellings lower to the same JSON
 *      node (`add(a, b)` vs `a + b`; `strcat(...)` vs `++` vs a template). The
 *      printer picks the one the spec designates canonical (spec §6): operators
 *      over stdlib calls, template/`++` over `strcat`, folded property-access
 *      paths.
 *   2. **Precedence-correct parenthesization.** Operators carry precedence and
 *      associativity, so a child is wrapped in `(...)` exactly when re-parsing
 *      would otherwise re-associate it.
 *
 * The guarantee is "bijective by normal form": `parse(print(json))` deep-equals
 * `json` for any canonical JSON. `print` does not attempt byte-exact recovery of
 * arbitrary hand-written source — that is normalized away.
 *
 * Not yet handled (tracked as open in `docs/shorthand-spec.md` §12): `$comment`
 * attachment. Comments have no canonical surface form, so any `$comment` sibling
 * key is dropped.
 */

import type { JSONType } from "../types";
import { fixedParamSchemas } from "../schema/schema.ts";
import {
  analyzeParameters,
  formatParameterIssue,
  type NormalizedField,
  type NormalizedParameter,
  type ParameterLayout,
} from "../params";
import { printType } from "./type-printer";

/** Pretty-print canonical json-fn JSON as `.jfn` shorthand source. */
export function print(node: JSONType): string {
  return emit(node, 0, "");
}

// ----- precedence ladder (mirror of parser.ts, spec §6) -----
//
// Higher binds tighter. Block/control forms (`if`, `cond`, `match`, function
// literals) are assigned the lowest precedence so that any operator or postfix
// context parenthesizes them — matching the fact that their tails (`else`
// branch, `=>` body) consume a full expression greedily.

const P_BLOCK = 0;
const P_ASCRIPTION = 1;
const P_OR = 2;
const P_AND = 3;
const P_CMP = 4;
const P_ADD = 5;
const P_MUL = 6;
const P_UNARY = 7;
const P_ATOM = 8;

/** Binary stdlib functions that print as operators, with their precedence. */
const BINARY_OPS: Record<string, { op: string; prec: number }> = {
  add: { op: "+", prec: P_ADD },
  sub: { op: "-", prec: P_ADD },
  mul: { op: "*", prec: P_MUL },
  div: { op: "/", prec: P_MUL },
  mod: { op: "%", prec: P_MUL },
};

// Comparison stdlib functions render as (non-associative) infix operators.
// Kept separate from `BINARY_OPS` because both operands must bind strictly
// tighter than the compare (see `renderComparison`), unlike the left-assoc
// arithmetic operators.
const COMPARISON_OPS: Record<string, string> = {
  eq: "==",
  neq: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Render `node`, wrapping in parentheses when its precedence is looser than the
 * slot requires (`minPrec`). */
function emit(node: JSONType, minPrec: number, indent: string): string {
  const { text, prec } = render(node, indent);
  return prec < minPrec ? `(${text})` : text;
}

/** A rendered node plus its surface precedence (for the caller's wrap decision). */
type Rendered = { text: string; prec: number };

function atom(text: string): Rendered {
  return { text, prec: P_ATOM };
}

function render(node: JSONType, indent: string): Rendered {
  if (node === null) return atom("null");
  switch (typeof node) {
    case "boolean":
      return atom(node ? "true" : "false");
    case "number":
      return atom(numberLiteral(node));
    case "string":
      return atom(JSON.stringify(node));
  }
  if (Array.isArray(node)) return atom(renderArray(node, indent));
  return renderObject(node, indent);
}

function renderObject(node: { [k: string]: JSONType }, indent: string): Rendered {
  if ("$call" in node) {
    // Effects sugar (shorthand-spec §13): a `bind` spine folds back to a
    // `do { … }` block and a `handle` call to `handle … with { … }`. Both are
    // exact inverses of the parser desugar, so the round-trip is preserved; any
    // shape that is not an exact desugar falls through to a plain call.
    const asDo = tryRenderDo(node, indent);
    if (asDo !== null) return asDo;
    return renderCall(node.$call!, (node.$args as JSONType[]) ?? [], indent);
  }
  if ("$fn" in node) return renderRef(node.$fn!, indent);
  if ("$var" in node) return atom(node.$var as string);
  if ("$get" in node && "$from" in node) return atom(renderFromAccess(node, indent));
  if ("$if" in node) return renderIf(node, indent);
  if ("$cond" in node) return renderCond(node, indent);
  if ("$match" in node) return renderMatch(node, indent);
  if ("$and" in node) return renderVariadicLogic(node.$and!, "&&", P_AND, indent);
  if ("$or" in node) return renderVariadicLogic(node.$or!, "||", P_OR, indent);
  if ("$nonnull" in node) return atom(`${emit(node.$nonnull!, P_ATOM, indent)}!`);
  if ("$as" in node && "$type" in node) {
    return {
      text: `${emit(node.$as!, P_ASCRIPTION + 1, indent)} as ${printType(node.$type!)}`,
      prec: P_ASCRIPTION,
    };
  }
  if ("$raw" in node) return atom(`raw ${JSON.stringify(node.$raw)}`);
  if ("$return" in node) return renderFunctionBody(node, indent);
  return atom(renderDataObject(node, indent));
}

// ----- calls, operators, references (spec §4, §6) -----

/** A function *reference* (`{ $fn: … }`) prints as `&name` / `&(expr)`. */
function renderRef(fn: JSONType, indent: string): Rendered {
  if (typeof fn === "string") return atom(`&${fn}`);
  return atom(`&(${emit(fn, P_BLOCK, indent)})`);
}

/** A function *call* (`{ $call, $args }`) prints as an operator, sugar, or a
 * `callee(args)` application. */
function renderCall(head: JSONType, args: JSONType[], indent: string): Rendered {
  if (typeof head === "string") {
    // Partial `handle(task, { …clauses… })` and total annotated
    // `handle(task, { …clauses… }, raw(schema))` print through the contextual
    // handle syntax. Only a literal clause object is expressible after `with`.
    if (head === "handle" && (args.length === 2 || args.length === 3) && isDataObject(args[1]!)) {
      const annotation =
        args.length === 3 && isPlainObject(args[2]!) && "$raw" in args[2]!
          ? (args[2]!.$raw as JSONType)
          : null;
      if (args.length === 2 || annotation !== null) {
        return renderHandle(args[0]!, args[1] as { [k: string]: JSONType }, annotation, indent);
      }
    }
    // Unary negation: `-x`, but only when it cannot fold back into a numeric
    // literal (`-5` would parse as the number, not `neg(5)`).
    if (head === "neg" && args.length === 1 && typeof args[0] !== "number") {
      return { text: `-${emit(args[0]!, P_UNARY, indent)}`, prec: P_UNARY };
    }
    // Logical negation: `!x`.
    if (head === "not" && args.length === 1) {
      return { text: `!${emit(args[0]!, P_UNARY, indent)}`, prec: P_UNARY };
    }
    if (head === "strcat") {
      const concat = renderStrcat(args, indent);
      if (concat !== null) return concat;
    }
    const bin = BINARY_OPS[head];
    if (bin !== undefined && args.length === 2) {
      const left = emit(args[0]!, bin.prec, indent);
      const right = emit(args[1]!, bin.prec + 1, indent);
      return { text: `${left} ${bin.op} ${right}`, prec: bin.prec };
    }
    const cmp = COMPARISON_OPS[head];
    if (cmp !== undefined && args.length === 2) {
      return renderComparison(cmp, args[0]!, args[1]!, indent);
    }
    return atom(`${head}(${renderArgs(args, indent)})`);
  }

  // Evaluated callee: parenthesize it (`(fnName)(...)`, `((x) => ...)(...)`).
  return atom(`(${emit(head!, P_BLOCK, indent)})(${renderArgs(args, indent)})`);
}

function renderArgs(args: JSONType[], indent: string): string {
  return args.map((a) => emit(a, P_BLOCK, indent)).join(", ");
}

/** Render a `strcat` call as a template (if it mixes literal text and holes) or
 * a `++` chain (if all operands are expressions). Returns `null` to fall back to
 * a plain `strcat(...)` call for degenerate shapes that would not round-trip
 * (fewer than two args, or all-literal segments that normalize to one string). */
function renderStrcat(args: JSONType[], indent: string): Rendered | null {
  if (args.length < 2) return null;
  const hasString = args.some((a) => typeof a === "string");
  const hasExpr = args.some((a) => typeof a !== "string");
  if (hasString && !hasExpr) return null;

  if (!hasString) {
    // Pure expressions -> `++` chain (left-associative, same precedence as `+`).
    const head = emit(args[0]!, P_ADD, indent);
    const rest = args.slice(1).map((a) => `++ ${emit(a, P_ADD + 1, indent)}`);
    return { text: [head, ...rest].join(" "), prec: P_ADD };
  }

  // Mixed literals and holes -> backtick template.
  let out = "`";
  for (const arg of args) {
    if (typeof arg === "string") {
      out += escapeTemplateSpan(arg);
    } else {
      out += `\${${emit(arg, P_BLOCK, indent)}}`;
    }
  }
  return atom(`${out}\``);
}

function escapeTemplateSpan(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "`") out += "\\`";
    else if (ch === "$") out += "\\$";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

// ----- effects: do-notation & handle (shorthand-spec §13) -----

/** One reconstructed `do` entry, the inverse of the parser's `DoEntry`. */
type DoEntry =
  | { kind: "effect"; name: string; value: JSONType } // `name <- value`
  | { kind: "pure"; name: string; value: JSONType } // `name: value`
  | { kind: "expr"; value: JSONType }; // bare final expression

/** Fold a `$fn` node back into a `do { … }` block when it is an exact
 * desugar image, else `null`. Two shapes qualify (see `parser.ts` `desugarDo`):
 * a bare `bind` spine, and a zero-arg IIFE `{ $fn: [scope] }` whose body is a
 * `bind` spine — the latter carries the pure bindings that preceded the first
 * effect. */
function tryRenderDo(node: { [k: string]: JSONType }, indent: string): Rendered | null {
  const args = node.$args;
  if (!Array.isArray(args)) return null;

  // Leading-pures IIFE: `{ $call: { …pures, $return: <bind-spine> }, $args: [] }`.
  if (args.length === 0) {
    const scope = node.$call;
    if (isPlainObject(scope!) && !("$params" in scope) && "$return" in scope) {
      const inner = collectDo(scope.$return!);
      if (inner === null) return null;
      const leading = objectLocals(scope);
      if (leading === null) return null;
      const pures: DoEntry[] = leading.map(([name, value]) => ({ kind: "pure", name, value }));
      return renderDo([...pures, ...inner], indent);
    }
    return null;
  }

  const entries = collectDo(node);
  return entries === null ? null : renderDo(entries, indent);
}

/** Reconstruct the `do` entries of a `bind` spine, or `null` if `node` is not
 * one. Each `bind(value, k)` yields an effect binding (or, when `k` takes no
 * parameter, a discard entry — a non-final bare expression) plus `k`'s locals
 * as pure bindings, then continues into `k`'s `$return`; a non-`bind` tail is
 * the final result expression. */
function collectDo(node: JSONType): DoEntry[] | null {
  if (!isPlainObject(node)) return null;
  const args = node.$args;
  if (node.$call !== "bind" || !Array.isArray(args) || args.length !== 2) return null;

  const k = args[1]!;
  if (!isPlainObject(k) || !("$return" in k)) return null;
  const analysis = analyzeParameters(k.$params);
  if (!analysis.ok) return null;
  const slots = analysis.layout.slots;
  // A zero-param continuation (no `$params`, or an empty list) is a discard:
  // the effect's result is dropped, so it prints as a bare non-final expression.
  const isDiscard = slots.length === 0;
  let head: DoEntry;
  if (isDiscard) {
    head = { kind: "expr", value: args[0]! };
  } else {
    if (slots.length !== 1 || slots[0]!.kind !== "required") return null;
    const name = slots[0]!.name;
    if (!IDENT_RE.test(name)) return null;
    head = { kind: "effect", name, value: args[0]! };
  }
  const locals = objectLocals(k);
  if (locals === null) return null;

  const entries: DoEntry[] = [head];
  for (const [pureName, value] of locals) entries.push({ kind: "pure", name: pureName, value });
  const rest = collectDo(k.$return!);
  entries.push(...(rest ?? [{ kind: "expr", value: k.$return! }]));
  return entries;
}

/** The non-`$` keys of a scope object as `[name, value]` locals in source order,
 * or `null` if any key is not a bare identifier (not spellable as a binding). */
function objectLocals(node: { [k: string]: JSONType }): [string, JSONType][] | null {
  const locals: [string, JSONType][] = [];
  for (const key of Object.keys(node)) {
    if (key.startsWith("$")) continue;
    if (!IDENT_RE.test(key)) return null;
    locals.push([key, node[key]!]);
  }
  return locals;
}

function renderDo(entries: DoEntry[], indent: string): Rendered {
  const inner = indent + "  ";
  const lines = entries.map((e) => {
    if (e.kind === "effect") return `${inner}${e.name} <- ${emit(e.value, P_BLOCK, inner)}`;
    if (e.kind === "pure") return `${inner}${e.name}: ${emit(e.value, P_BLOCK, inner)}`;
    return `${inner}${emit(e.value, P_BLOCK, inner)}`;
  });
  return { text: `do {\n${lines.join(",\n")}\n${indent}}`, prec: P_BLOCK };
}

function renderHandle(
  task: JSONType,
  handlers: { [k: string]: JSONType },
  annotation: JSONType | null,
  indent: string,
): Rendered {
  const clauses = renderDataObject(handlers, indent);
  const resultType = annotation === null ? "" : ` -> ${printType(annotation)}`;
  return {
    text: `handle ${emit(task, P_BLOCK, indent)}${resultType} with ${clauses}`,
    prec: P_BLOCK,
  };
}

/** Whether `value` is a plain object with no `$`-prefixed keys — the shape that
 * prints as a shorthand data object (spec §3) rather than a special form. */
function isDataObject(value: JSONType): value is { [k: string]: JSONType } {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every((k) => !k.startsWith("$"));
}

function isPlainObject(value: unknown): value is { [k: string]: JSONType } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ----- variables and property access (spec §5) -----

function renderFromAccess(node: { [k: string]: JSONType }, indent: string): string {
  return emit(node.$from!, P_ATOM, indent) + renderGet(node.$get!, indent);
}

/** Turn a `$get` value (scalar key, numeric index, computed expression, or an
 * array path folding several static segments) into an access suffix. */
function renderGet(get: JSONType, indent: string): string {
  if (Array.isArray(get)) return get.map((seg) => renderSegment(seg, indent)).join("");
  return renderSegment(get, indent);
}

function renderSegment(seg: JSONType, indent: string): string {
  if (typeof seg === "string") return IDENT_RE.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
  if (typeof seg === "number") return `[${numberLiteral(seg)}]`;
  return `[${emit(seg, P_BLOCK, indent)}]`;
}

// ----- control flow (spec §7) -----

function renderIf(node: { [k: string]: JSONType }, indent: string): Rendered {
  const cond = emit(node.$if!, P_BLOCK, indent);
  const then = emit(node.$then!, P_BLOCK, indent);
  const els = emit(node.$else!, P_BLOCK, indent);
  return { text: `if ${cond} then ${then} else ${els}`, prec: P_BLOCK };
}

function renderCond(node: { [k: string]: JSONType }, indent: string): Rendered {
  const arms = node.$cond as [JSONType, JSONType][];
  const inner = indent + "  ";
  const lines = arms.map(
    ([c, r]) => `${inner}${emit(c, P_BLOCK, inner)} -> ${emit(r, P_BLOCK, inner)}`,
  );
  if ("$else" in node) lines.push(`${inner}else -> ${emit(node.$else!, P_BLOCK, inner)}`);
  return { text: `cond {\n${lines.join(",\n")}\n${indent}}`, prec: P_BLOCK };
}

function renderMatch(node: { [k: string]: JSONType }, indent: string): Rendered {
  const subject = emit(node.$match!, P_BLOCK, indent);
  const cases = node.$cases as [JSONType, JSONType][];
  const inner = indent + "  ";
  const lines = cases.map(
    ([c, r]) => `${inner}${emit(c, P_BLOCK, inner)} -> ${emit(r, P_BLOCK, inner)}`,
  );
  lines.push(`${inner}else -> ${emit(node.$else!, P_BLOCK, inner)}`);
  return { text: `match ${subject} {\n${lines.join(",\n")}\n${indent}}`, prec: P_BLOCK };
}

// ----- logic and comparison forms (spec §6) -----

function renderVariadicLogic(
  operands: JSONType,
  op: string,
  prec: number,
  indent: string,
): Rendered {
  const parts = (operands as JSONType[]).map((o) => emit(o, prec + 1, indent));
  return { text: parts.join(` ${op} `), prec };
}

function renderComparison(op: string, a: JSONType, b: JSONType, indent: string): Rendered {
  // Non-associative: both operands must bind strictly tighter than the compare.
  const left = emit(a, P_CMP + 1, indent);
  const right = emit(b, P_CMP + 1, indent);
  return { text: `${left} ${op} ${right}`, prec: P_CMP };
}

// ----- function bodies & where bindings (spec §8) -----

function renderFunctionBody(node: { [k: string]: JSONType }, indent: string): Rendered {
  const analysis = analyzeParameters(node.$params);
  if (!analysis.ok) throw new Error(formatParameterIssue(analysis.issue));
  // Locals are the non-`$` keys, in source (insertion) order. Other `$` keys
  // (e.g. `$comment`) have no canonical surface form and are dropped.
  const locals = Object.keys(node).filter((k) => !k.startsWith("$"));
  const header = renderFunctionHeader(analysis.layout, node.$sig);

  if (locals.length === 0) {
    return { text: `${header} ${emit(node.$return!, P_BLOCK, indent)}`, prec: P_BLOCK };
  }
  const inner = indent + "  ";
  // The `where` clause is a postfix on the return expression. If the return's
  // surface form ends with an *open* expression whose parse would greedily
  // extend — an `if/then/else` (its `else` tail) or a nested function literal
  // (its `=>` body) — the trailing `where` would re-attach to that inner tail
  // instead of this body on re-parse. Parenthesize such returns so the `where`
  // binds here. Brace-terminated blocks (`cond`/`match`) and every operator/
  // call/data form stop before `where`, so they need no guard.
  const retText = emit(node.$return!, P_BLOCK, indent);
  const ret = returnAbsorbsTrailingWhere(node.$return!) ? `(${retText})` : retText;
  const bindings = locals.map((k) => `${inner}${k}: ${emit(node[k]!, P_BLOCK, inner)}`);
  const body = `${ret} where {\n${bindings.join(",\n")}\n${indent}}`;
  return { text: `${header} ${body}`, prec: P_BLOCK };
}

function renderFunctionHeader(layout: ParameterLayout, sig: JSONType | undefined): string {
  if (!isPlainObject(sig)) return `(${layout.slots.map(renderParam).join(", ")}) =>`;
  const required = Array.isArray(sig.required) ? sig.required : [];
  const optional = Array.isArray(sig.optional) ? sig.optional : [];
  if (required.length !== layout.requiredCount || optional.length !== layout.omittableCount) {
    throw new Error(
      "Cannot print function signature whose required/optional shape does not match $params",
    );
  }
  const fixed = fixedParamSchemas({
    required,
    optional,
    rest: sig.rest,
    returns: sig.returns ?? true,
  });
  const rendered = layout.slots.map((param) => {
    if (param.kind === "rest") {
      const rest = sig.rest;
      if (rest === undefined) throw new Error("Cannot print typed rest parameter without sig.rest");
      return `${renderParam(param)}: ${printType(rest)}[]`;
    }
    const schema = fixed[param.index];
    if (schema === undefined)
      throw new Error("Cannot print typed parameter without a matching signature slot");
    return renderTypedParam(param, schema);
  });
  if (layout.fixedCount !== fixed.length) {
    throw new Error("Cannot print function signature with more fixed types than parameters");
  }
  if (layout.rest === null && sig.rest !== undefined) {
    throw new Error("Cannot print function signature with a rest type but no rest parameter");
  }
  return `(${rendered.join(", ")}) -> ${printType(sig.returns ?? true)} =>`;
}

/** Whether a function-body `$return`, printed bare, would swallow a following
 * `where` into a sub-expression rather than the body. True for `if/then/else`
 * (the `else` branch is an open expression) and nested function literals (the
 * `=>` body is open). `cond`/`match` close with `}` and all operator/call/data
 * forms stop before `where`, so they are safe. */
function returnAbsorbsTrailingWhere(node: JSONType): boolean {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  return "$if" in node || "$return" in node;
}

/** Render one normalized `$params` slot. */
function renderParam(param: NormalizedParameter): string {
  if (param.kind === "required") return param.name;
  if (param.kind === "rest") return `...${param.name}`;
  if (param.kind === "fields") {
    return `{ ${param.bindings.map(renderField).join(", ")} }`;
  }
  if (param.kind === "optional") return `${param.name}?`;
  return `${param.name} = ${emit(param.defaultExpression, P_BLOCK, "")}`;
}

function renderTypedParam(param: NormalizedParameter, schema: JSONType): string {
  const type = printType(schema);
  if (param.kind === "optional") return `${param.name}?: ${type}`;
  if (param.kind === "defaulted") {
    return `${param.name}: ${type} = ${emit(param.defaultExpression, P_BLOCK, "")}`;
  }
  return `${renderParam(param)}: ${type}`;
}

function renderField(field: NormalizedField): string {
  if (field.kind === "required") return field.name;
  if (field.kind === "optional") return `${field.name}?`;
  return `${field.name} = ${emit(field.defaultExpression, P_BLOCK, "")}`;
}

// ----- data (spec §3) -----

function renderArray(arr: JSONType[], indent: string): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map((el) => emit(el, P_BLOCK, indent)).join(", ")}]`;
}

function renderDataObject(node: { [k: string]: JSONType }, indent: string): string {
  // `$comment` has no canonical shorthand surface form, so we ignore it for now
  // rather than letting it force the whole object into a `raw` island.
  const keys = Object.keys(node).filter((k) => k !== "$comment");
  // A data object cannot carry `$`-prefixed keys (the parser forbids them), so
  // such an object is only expressible as an inert `raw` island.
  if (keys.some((k) => k.startsWith("$"))) return `raw ${JSON.stringify(node)}`;
  if (keys.length === 0) return "{}";

  const entry = (k: string, ind: string): string => {
    // Shorthand-property punning: `{ key: { $var: key } }` prints as `{ key }`
    // when the key is a bare identifier (the canonical, narrower spelling).
    if (IDENT_RE.test(k) && isVarPun(node[k]!, k)) return k;
    return `${IDENT_RE.test(k) ? k : JSON.stringify(k)}: ${emit(node[k]!, P_BLOCK, ind)}`;
  };

  if (keys.length === 1) return `{ ${entry(keys[0]!, indent)} }`;

  const inner = indent + "  ";
  return `{\n${keys.map((k) => inner + entry(k, inner)).join(",\n")}\n${indent}}`;
}

/** Whether `value` is exactly `{ "$var": name }` (a bare variable read of
 * `name`, with no `$get` path or other keys) — the punnable data-object value. */
function isVarPun(value: JSONType, name: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "$var" && value.$var === name;
}

/** Serialize a number the way the lexer expects to read it back. */
function numberLiteral(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`cannot print non-finite number ${n}`);
  return JSON.stringify(n);
}
