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
const P_OR = 1;
const P_AND = 2;
const P_CMP = 3;
const P_ADD = 4;
const P_MUL = 5;
const P_UNARY = 6;
const P_ATOM = 7;

const COMPARISONS: Record<string, string> = {
  $eq: "==",
  $neq: "!=",
  $lt: "<",
  $lte: "<=",
  $gt: ">",
  $gte: ">=",
};

/** Binary stdlib functions that print as operators, with their precedence. */
const BINARY_OPS: Record<string, { op: string; prec: number }> = {
  add: { op: "+", prec: P_ADD },
  sub: { op: "-", prec: P_ADD },
  mul: { op: "*", prec: P_MUL },
  div: { op: "/", prec: P_MUL },
  mod: { op: "%", prec: P_MUL },
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
  if ("$fn" in node) return renderFn(node.$fn!, indent);
  if ("$var" in node) return atom(renderVarAccess(node, indent));
  if ("$get" in node && "$from" in node) return atom(renderFromAccess(node, indent));
  if ("$if" in node) return renderIf(node, indent);
  if ("$cond" in node) return renderCond(node, indent);
  if ("$match" in node) return renderMatch(node, indent);
  if ("$and" in node) return renderVariadicLogic(node.$and!, "&&", P_AND, indent);
  if ("$or" in node) return renderVariadicLogic(node.$or!, "||", P_OR, indent);
  for (const key of Object.keys(COMPARISONS)) {
    if (key in node) return renderComparison(key, node[key]!, indent);
  }
  if ("$not" in node) return { text: `!${emit(node.$not!, P_UNARY, indent)}`, prec: P_UNARY };
  if ("$raw" in node) return atom(`raw ${JSON.stringify(node.$raw)}`);
  if ("$return" in node) return renderFunctionBody(node, indent);
  return atom(renderDataObject(node, indent));
}

// ----- calls, operators, references (spec §4, §6) -----

function renderFn(fn: JSONType, indent: string): Rendered {
  // Non-array `$fn` is a function *reference* (`&name` / `&(expr)`).
  if (!Array.isArray(fn)) {
    if (typeof fn === "string") return atom(`&${fn}`);
    return atom(`&(${emit(fn, P_BLOCK, indent)})`);
  }
  const head = fn[0];
  const args = fn.slice(1);

  if (typeof head === "string") {
    // Unary negation: `-x`, but only when it cannot fold back into a numeric
    // literal (`-5` would parse as the number, not `neg(5)`).
    if (head === "neg" && args.length === 1 && typeof args[0] !== "number") {
      return { text: `-${emit(args[0]!, P_UNARY, indent)}`, prec: P_UNARY };
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

// ----- variables and property access (spec §5) -----

function renderVarAccess(node: { [k: string]: JSONType }, indent: string): string {
  const name = node.$var as string;
  if ("$get" in node) return name + renderGet(node.$get!, indent);
  return name;
}

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

function renderComparison(key: string, operands: JSONType, indent: string): Rendered {
  const [a, b] = operands as [JSONType, JSONType];
  // Non-associative: both operands must bind strictly tighter than the compare.
  const left = emit(a, P_CMP + 1, indent);
  const right = emit(b, P_CMP + 1, indent);
  return { text: `${left} ${COMPARISONS[key]} ${right}`, prec: P_CMP };
}

// ----- function bodies & where bindings (spec §8) -----

function renderFunctionBody(node: { [k: string]: JSONType }, indent: string): Rendered {
  const params = Array.isArray(node.$params) ? (node.$params as JSONType[]) : [];
  // Locals are the non-`$` keys, in source (insertion) order. Other `$` keys
  // (e.g. `$comment`) have no canonical surface form and are dropped.
  const locals = Object.keys(node).filter((k) => !k.startsWith("$"));
  const header = `(${params.map(renderParam).join(", ")}) =>`;

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

/** Whether a function-body `$return`, printed bare, would swallow a following
 * `where` into a sub-expression rather than the body. True for `if/then/else`
 * (the `else` branch is an open expression) and nested function literals (the
 * `=>` body is open). `cond`/`match` close with `}` and all operator/call/data
 * forms stop before `where`, so they are safe. */
function returnAbsorbsTrailingWhere(node: JSONType): boolean {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  return "$if" in node || "$return" in node;
}

/** Render one `$params` slot: a plain name, a `...rest` collector, or an object
 * pattern `{ f1, f2 }` (space inside braces, `, ` between — purely aesthetic;
 * the reparsed `$fields` array is identical). */
function renderParam(p: JSONType): string {
  if (typeof p === "string") return p;
  const fields = (p as { $fields: string[] }).$fields;
  return `{ ${fields.join(", ")} }`;
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
