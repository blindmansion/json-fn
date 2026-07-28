/**
 * Recursive-descent + precedence-climbing parser that lowers `.jfn` shorthand
 * directly to canonical json-fn JSON. There is no separate shorthand AST: the
 * canonical JSON *is* the tree, and the lowering rules from
 * `docs/shorthand-spec.md` are applied inline.
 */

import type { FieldPattern, FunctionBody, JSONType, Param } from "../types";
import { analyzeParameters, formatParameterIssue } from "../params";
import { TokenCursor, describe } from "./cursor";
import { lex } from "./lexer";
import type { TemplatePart, TokPunct } from "./lexer";
import { TypeParser, arrayElement } from "./type-parser";
import type { Schema } from "./type-parser";

/** Parse a full `.jfn` module, returning its canonical json-fn object. */
export function parse(src: string): JSONType {
  return parseModule(src);
}

/** Parse an implicit `.jfn` module body. Module braces are not part of the syntax. */
export function parseModule(src: string): JSONType {
  const tokens = lex(src);
  const p = new Parser(tokens);
  const v = p.parseModule();
  p.expect("eof", "end of input");
  return v;
}

/** Parse one standalone shorthand expression. */
export function parseExpression(src: string): JSONType {
  const tokens = lex(src);
  const p = new Parser(tokens);
  const v = p.parseExpression();
  p.expect("eof", "end of input");
  return v;
}

/** One property-access step gathered during postfix parsing. */
type Seg =
  | { kind: "static"; value: JSONType } // literal key/index that folds into a `$get` path
  | { kind: "computed"; value: JSONType }; // computed key that breaks a static run

/** One ordered segment in an array literal or call argument list. */
type SpreadPart = { kind: "plain"; values: JSONType[] } | { kind: "spread"; value: JSONType };

type ParsedSpreadList = {
  parts: SpreadPart[];
  hasSpread: boolean;
};

/** One ordered object-literal chunk before `merge` lowering. */
type ObjectChunk =
  | { kind: "plain"; value: Record<string, JSONType> }
  | { kind: "spread"; value: JSONType }
  | { kind: "computed"; value: JSONType };

// Comparison operators lower to stdlib function calls (exactly as `+`→`add`),
// so the core no longer needs first-class comparator nodes.
const COMPARISON_OPS: Partial<Record<TokPunct, string>> = {
  eqeq: "eq",
  bangeq: "neq",
  lt: "lt",
  lteq: "lte",
  gt: "gt",
  gteq: "gte",
};

const ORDERED_COMPARISON_NAMES = new Set(["lt", "lte", "gt", "gte"]);
const COMPARISON_TEMP_PREFIX = "__jfn_cmp_";

class Parser extends TokenCursor {
  // ----- source entry points -----

  parseExpression(): JSONType {
    return this.parseBody();
  }

  // ----- expression precedence ladder (spec section 6) -----

  parseExpr(): JSONType {
    return this.parseAscription();
  }

  private parseAscription(): JSONType {
    const value = this.parseOr();
    if (!this.eatKeyword("checked")) return value;
    this.expectKeyword("as");
    const type = this.parseTypeExpr();
    // Ascription is deliberately non-associative. Parentheses make repeated
    // checks explicit: `(value checked as A) checked as B`.
    if (this.isKeyword("checked")) {
      throw this.err("checked ascription is non-associative");
    }
    return { $as: value, $type: type };
  }

  private parseOr(): JSONType {
    const parts = [this.parseAnd()];
    while (this.peekType() === "oror") {
      this.advance();
      parts.push(this.parseAnd());
    }
    return parts.length === 1 ? parts[0]! : { $or: parts };
  }

  private parseAnd(): JSONType {
    const first = this.parseCmp();
    const parts = first.chainParts ?? [first.value];
    while (this.peekType() === "andand") {
      this.advance();
      const next = this.parseCmp();
      parts.push(...(next.chainParts ?? [next.value]));
    }
    return parts.length === 1 ? parts[0]! : { $and: parts };
  }

  private parseCmp(): { value: JSONType; chainParts?: JSONType[] } {
    const operands = [this.parseAdd()];
    const names: string[] = [];
    for (;;) {
      const name = COMPARISON_OPS[this.peekType() as TokPunct];
      if (name === undefined) break;
      this.advance();
      names.push(name);
      operands.push(this.parseAdd());
    }

    if (names.length === 0) return { value: operands[0]! };
    if (names.length === 1) {
      return { value: fncall(names[0]!, [operands[0]!, operands[1]!]) };
    }
    if (names.some((name) => !ORDERED_COMPARISON_NAMES.has(name))) {
      throw this.err("only ordered comparison operators can be chained");
    }

    const usedNames = collectStrings(operands);
    const bindings: [string, JSONType][] = [];
    const loweredOperands = [...operands];
    for (let i = 1; i < operands.length - 1; i++) {
      const operand = operands[i]!;
      if (isRepeatSafeComparisonOperand(operand)) continue;
      const temp = freshComparisonTemp(usedNames);
      bindings.push([temp, operand]);
      loweredOperands[i] = { $var: temp };
    }

    const comparisons = names.map((name, i) =>
      fncall(name, [loweredOperands[i]!, loweredOperands[i + 1]!]),
    );
    const conjunction: JSONType = { $and: comparisons };
    return bindings.length === 0
      ? { value: conjunction, chainParts: comparisons }
      : { value: buildLet(bindings, conjunction) };
  }

  private parseAdd(): JSONType {
    let left = this.parseMul();
    // Tracks whether `left` is a `strcat` node produced by `++` at this level,
    // so a run of `++` flattens into one variadic call.
    let leftIsConcat = false;
    for (;;) {
      const type = this.peekType();
      if (type === "plus") {
        this.advance();
        left = fncall("add", [left, this.parseMul()]);
        leftIsConcat = false;
      } else if (type === "minus") {
        this.advance();
        left = fncall("sub", [left, this.parseMul()]);
        leftIsConcat = false;
      } else if (type === "plusplus") {
        this.advance();
        const right = this.parseMul();
        if (leftIsConcat) {
          pushArg(left, right);
        } else {
          left = fncall("strcat", [left, right]);
          leftIsConcat = true;
        }
      } else {
        return left;
      }
    }
  }

  private parseMul(): JSONType {
    let left = this.parseUnary();
    for (;;) {
      const type = this.peekType();
      let name: string;
      if (type === "star") name = "mul";
      else if (type === "slash") name = "div";
      else if (type === "percent") name = "mod";
      else return left;
      this.advance();
      left = fncall(name, [left, this.parseUnary()]);
    }
  }

  private parseUnary(): JSONType {
    const type = this.peekType();
    if (type === "bang") {
      this.advance();
      return fncall("not", [this.parseUnary()]);
    }
    if (type === "minus") {
      this.advance();
      const e = this.parseUnary();
      // `-<number literal>` folds into a negative literal; otherwise `neg(expr)`.
      return typeof e === "number" ? -e : fncall("neg", [e]);
    }
    return this.parsePostfix();
  }

  private parsePostfix(): JSONType {
    let { value: val, name } = this.parsePrimary();
    for (;;) {
      const type = this.peekType();
      if (type === "lparen") {
        // Bare identifier in call position is a literal function name; anything
        // else is an evaluated callee (spec section 4).
        const callee: JSONType = name !== null ? name : val;
        this.advance();
        const parsed = this.parseCallArgs();
        if (parsed.hasSpread) {
          // `apply` needs the callee as a value. A named `$fn` preserves direct
          // call resolution, including registry fallback past non-function
          // lexical bindings; a `$var` would not.
          const calleeValue: JSONType = name !== null ? { $fn: name } : val;
          val = fncall("apply", [calleeValue, lowerSpreadParts(parsed.parts, true)]);
        } else {
          val = { $call: callee, $args: plainValues(parsed.parts) };
        }
        name = null;
      } else if (type === "dot" || type === "lbracket") {
        const segs = this.gatherAccess();
        const base: JSONType = name !== null ? { $var: name } : val;
        name = null;
        val = buildAccess(base, segs);
      } else if (type === "bang") {
        // Postfix `!` is the runtime-checked non-null assertion. A bare
        // identifier becomes a variable read before the assertion is wrapped.
        this.advance();
        val = { $nonnull: name !== null ? { $var: name } : val };
        name = null;
      } else {
        return val;
      }
    }
  }

  /** Consume a maximal run of `.name` / `[...]` access segments. */
  private gatherAccess(): Seg[] {
    const segs: Seg[] = [];
    for (;;) {
      const type = this.peekType();
      if (type === "dot") {
        this.advance();
        const key = this.expectIdent("property name after '.'");
        segs.push({ kind: "static", value: key });
      } else if (type === "lbracket") {
        this.advance();
        const inner = this.parseExpr();
        this.expect("rbracket", "']'");
        // Literal string/number keys are static (foldable); everything else is
        // a computed key.
        if (typeof inner === "string" || typeof inner === "number") {
          segs.push({ kind: "static", value: inner });
        } else {
          segs.push({ kind: "computed", value: inner });
        }
      } else {
        return segs;
      }
    }
  }

  // ----- primary expressions -----

  /** Returns the primary's value plus, for a bare identifier, its name (so the
   * postfix loop can decide named-call vs variable-reference). */
  private parsePrimary(): { value: JSONType; name: string | null } {
    const t = this.peek();
    switch (t.type) {
      case "num":
        this.advance();
        return { value: t.value, name: null };
      case "str":
        this.advance();
        return { value: t.value, name: null };
      case "template":
        this.advance();
        return { value: this.lowerTemplate(t.parts), name: null };
      case "amp":
        this.advance();
        return { value: this.parseFnReference(), name: null };
      case "lbracket":
        this.advance();
        return { value: this.parseArray(), name: null };
      case "lbrace":
        this.advance();
        return { value: this.parseDataObject(), name: null };
      case "lparen":
        if (this.looksLikeFuncLit()) {
          return { value: this.parseFuncLit(), name: null };
        }
        this.advance();
        {
          const e = this.parseBody();
          this.expect("rparen", "')'");
          return { value: e, name: null };
        }
      case "ident":
        switch (t.value) {
          case "true":
            this.advance();
            return { value: true, name: null };
          case "false":
            this.advance();
            return { value: false, name: null };
          case "null":
            this.advance();
            return { value: null, name: null };
          case "if":
            this.advance();
            return { value: this.parseIf(), name: null };
          case "cond":
            this.advance();
            return { value: this.parseCond(), name: null };
          case "match":
            this.advance();
            return { value: this.parseMatch(), name: null };
          case "do":
            this.advance();
            return { value: this.parseDo(), name: null };
          case "handle":
            this.advance();
            return { value: this.parseHandle(), name: null };
          case "raw":
            this.advance();
            return { value: this.parseRaw(), name: null };
          case "let":
            throw this.err("the 'let { ... } in expr' form is replaced by 'expr where { ... }'");
          case "where":
            throw this.err("'where { ... }' must immediately follow an expression");
          default:
            this.advance();
            return { value: { $var: t.value }, name: t.value };
        }
      default:
        throw this.err(`unexpected token ${describe(t)}`);
    }
  }

  private parseFnReference(): JSONType {
    // `&` already consumed.
    if (this.peekType() === "lparen") {
      this.advance();
      const operandStart = this.pos;
      const e = this.parseExpr();
      const operandEnd = this.pos;
      this.expect("rparen", "')'");
      if (Array.isArray(e) || this.isGroupedArrayLiteral(operandStart, operandEnd)) {
        throw this.err(
          "function references cannot contain array literals; use a call expression instead",
        );
      }
      return { $fn: e };
    }
    const name = this.expectIdent("function name after '&'");
    return { $fn: name };
  }

  /** Whether a parsed `&(...)` operand is syntactically an array literal,
   * allowing redundant grouping. Spread arrays lower to `concat` and therefore
   * cannot be recognized from the resulting canonical node alone. */
  private isGroupedArrayLiteral(start: number, end: number): boolean {
    while (
      this.tokens[start]?.tok.type === "lparen" &&
      this.matchingDelimiter(start, end, "lparen", "rparen") === end - 1
    ) {
      start++;
      end--;
    }
    return (
      this.tokens[start]?.tok.type === "lbracket" &&
      this.matchingDelimiter(start, end, "lbracket", "rbracket") === end - 1
    );
  }

  private matchingDelimiter(
    start: number,
    end: number,
    open: "lparen" | "lbracket",
    close: "rparen" | "rbracket",
  ): number | null {
    let depth = 0;
    for (let i = start; i < end; i++) {
      const type = this.tokens[i]!.tok.type;
      if (type === open) depth++;
      else if (type === close && --depth === 0) return i;
    }
    return null;
  }

  private parseArray(): JSONType {
    // `[` already consumed.
    const parsed = this.parseSpreadList("rbracket", "']'", "array");
    return parsed.hasSpread ? lowerSpreadParts(parsed.parts, false) : plainValues(parsed.parts);
  }

  private parseDataObject(): JSONType {
    // `{` already consumed. Ordinary keys are literal data; computed keys and
    // spreads lower through `fromEntries` and `merge`.
    let map: Record<string, JSONType> = {};
    const chunks: ObjectChunk[] = [];
    let hasDynamicEntry = false;
    if (this.peekType() === "rbrace") {
      this.advance();
      return map;
    }
    for (;;) {
      if (this.peekType() === "dotdotdot") {
        hasDynamicEntry = true;
        map = flushObjectMap(map, chunks);
        this.advance();
        chunks.push({ kind: "spread", value: this.parseExpr() });
      } else if (this.peekType() === "lbracket") {
        hasDynamicEntry = true;
        map = flushObjectMap(map, chunks);
        chunks.push({ kind: "computed", value: this.parseComputedDataEntry() });
      } else {
        this.parseDataEntry(map);
      }
      if (this.consumeObjectSep("data object")) break;
    }
    if (!hasDynamicEntry) return map;
    flushObjectMap(map, chunks);
    return lowerObjectChunks(chunks);
  }

  /** Parse one ordinary object entry (binding / constant / pun) into `map`.
   * Shared by `parseDataObject` and `parseModule`. */
  private parseDataEntry(map: Record<string, JSONType>): void {
    const t = this.peek();
    let key: string;
    let bareIdent = false;
    if (t.type === "ident" || t.type === "str") {
      this.advance();
      key = t.value;
      bareIdent = t.type === "ident";
    } else {
      throw this.err(`expected data-object key, found ${describe(t)}`);
    }
    if (key.startsWith("$")) {
      throw this.err(
        `data-object key "${key}" must not start with '$'; use 'raw' for $-keyed data`,
      );
    }
    // Shorthand-property punning: a bare identifier key not followed by `:`
    // stands for `key: key`, lowering to a `$var` read of the same name.
    if (bareIdent && (this.peekType() === "comma" || this.peekType() === "rbrace")) {
      map[key] = { $var: key };
    } else {
      this.expect("colon", "':' after data-object key");
      map[key] = this.parseExpr();
    }
  }

  /** Parse `[key]: value`, lowering the entry to a one-pair `fromEntries` call. */
  private parseComputedDataEntry(): JSONType {
    this.expect("lbracket", "'[' for computed data-object key");
    const key = this.parseExpr();
    this.expect("rbracket", "']' after computed data-object key");
    this.expect("colon", "':' after computed data-object key");
    const value = this.parseExpr();
    return fncall("fromEntries", [[[key, value]]]);
  }

  /** Consume the `,`/`}` after an object entry. Returns `true` when the object
   * has closed (a `}` was consumed), `false` to continue the loop. */
  private consumeObjectSep(what: string): boolean {
    const type = this.peekType();
    if (type === "comma") {
      this.advance();
      if (this.peekType() === "rbrace") {
        this.advance();
        return true;
      }
      return false;
    }
    if (type === "rbrace") {
      this.advance();
      return true;
    }
    throw this.err(`expected ',' or '}' in ${what}`);
  }

  /** Parse an implicit top-level module body. This is a superset of data-object
   * entries that also recognizes `type Name = <type>` declarations and lowers
   * them into a reserved `$types` sibling (spec §8). */
  parseModule(): JSONType {
    const map: Record<string, JSONType> = {};
    const types: Record<string, Schema> = {};
    if (this.peekType() === "eof") return map;
    for (;;) {
      // `type` is a contextual keyword only when followed by an identifier (the
      // type name); `type: expr` and the `{ type }` pun stay data entries.
      if (this.isKeyword("type") && this.peek2().type === "ident") {
        this.advance();
        const name = this.expectIdent("type name");
        if (name === "Task") {
          throw this.err("'Task' is reserved for the built-in Task<A> type constructor");
        }
        if (name in types) {
          throw this.err(`duplicate type declaration '${name}'`);
        }
        this.expect("equals", "'=' in type declaration");
        types[name] = this.parseTypeExpr();
      } else if (this.peekType() === "dotdotdot" || this.peekType() === "lbracket") {
        throw this.err("module entries must be named bindings or type declarations");
      } else {
        this.parseDataEntry(map);
      }
      if (this.consumeModuleSep()) break;
    }
    if (Object.keys(types).length > 0) {
      return { $types: types, ...map };
    }
    return map;
  }

  /** Require a physical newline or EOF after a module entry. */
  private consumeModuleSep(): boolean {
    if (this.peekType() === "eof") return true;
    const previous = this.tokens[this.pos - 1]!;
    const next = this.tokens[this.pos]!;
    if (next.tok.type !== "comma" && next.line > previous.endLine) return false;
    throw this.err(`expected newline or end of input in module`);
  }

  /** Spin up the type-expression sub-parser at the current cursor, parse one
   * `<type>`, and resync the term parser to where types left off. */
  private parseTypeExpr(): Schema {
    const tp = new TypeParser(this.tokens, this.pos);
    const schema = tp.parseType();
    this.pos = tp.position();
    return schema;
  }

  // ----- function literals & let-bindings (spec section 8) -----

  /** Peek whether the `(` at the cursor begins a function literal: either
   * `( params ) =>` (bare) or `( params ) -> <type> =>` (typed). The latter is
   * confirmed by parsing the return type and checking for the `=>`, which
   * distinguishes a typed lambda from a parenthesized expression. */
  private looksLikeFuncLit(): boolean {
    let depth = 0;
    let i = this.pos;
    for (;;) {
      const t = this.tokens[i]?.tok;
      if (t === undefined || t.type === "eof") return false;
      if (t.type === "lparen") {
        depth++;
      } else if (t.type === "rparen") {
        depth--;
        if (depth === 0) {
          const next = this.tokens[i + 1]?.tok.type;
          if (next === "fatarrow") return true;
          if (next === "arrow") return this.returnTypeEndsInFatArrow(i + 2);
          return false;
        }
      }
      i++;
    }
  }

  /** Lookahead from `start` (just past a `->`): is this the return annotation of
   * a typed-lambda header — i.e. is there a `=>` after the return type at the
   * same bracket depth the `->` sits at?
   *
   * We scan tokens with bracket tracking rather than speculatively *parsing* the
   * return type. The type never contains a top-level `=>` (function types use
   * `->`) or a top-level `,`/closer (unions/intersections have none; tuples,
   * objects, and function params are bracketed), so the first depth-0 `=>` is
   * this lambda's arrow, while a depth-0 `,`/closer/EOF means this is a
   * parenthesized expression and never reaches one.
   *
   * Scanning (not parsing) is deliberate: a *malformed* return annotation still
   * looks like a typed-lambda header, so it routes into `parseFuncLit` and its
   * `parseTypeExpr` surfaces the real type error *at the annotation* — instead
   * of the old try/catch swallowing it, dropping back to a parenthesized
   * expression, and mis-reporting at the parameter colon. */
  private returnTypeEndsInFatArrow(start: number): boolean {
    let depth = 0;
    for (let i = start; ; i++) {
      const t = this.tokens[i]?.tok;
      if (t === undefined || t.type === "eof") return false;
      if (t.type === "lparen" || t.type === "lbracket" || t.type === "lbrace") {
        depth++;
      } else if (t.type === "rparen" || t.type === "rbracket" || t.type === "rbrace") {
        if (depth === 0) return false; // the enclosing group closed: not a lambda
        depth--;
      } else if (depth === 0) {
        if (t.type === "fatarrow") return true;
        if (t.type === "comma") return false; // end of this arm / element
      }
    }
  }

  private parseFuncLit(): JSONType {
    const parsed = this.parseParams();
    // Optional `-> <type>` return annotation before the `=>`.
    let returns: Schema | null = null;
    if (this.peekType() === "arrow") {
      this.advance();
      returns = this.parseTypeExpr();
    }
    const sig = this.buildSig(parsed, returns);
    this.expect("fatarrow", "'=>'");
    // Body is `expr` optionally followed by a `where { ... }` clause supplying
    // the (lazy, order-independent) locals. `where` is not an operator, so
    // `parseExpr` stops before it and we consume the clause here.
    const ret = this.parseExpr();
    const locals = this.eatKeyword("where") ? this.parseWhereBindings() : [];
    const result = locals.length === 0 ? ret : buildLet(locals, ret);
    return this.buildFunctionBody(parsed.params, result, sig);
  }

  /** Enforce all-or-nothing signatures (spec §7) and, when a function is fully
   * typed, assemble its `$sig` node (positionally aligned with `$params`, with
   * a rest param contributing `rest`). Returns `null` for a bare function. */
  private buildSig(parsed: ParsedParams, returns: Schema | null): Schema | null {
    const slots = parsed.params.length;
    const annotated = parsed.slotSchemas.filter((s) => s !== null).length;
    const hasReturn = returns !== null;

    const fullyTyped = slots > 0 ? annotated === slots && hasReturn : hasReturn;
    const bare = annotated === 0 && !hasReturn;
    if (!fullyTyped && !bare) {
      if (annotated > 0 && annotated < slots) {
        throw this.err("all parameters must be typed, or none");
      }
      if (annotated === slots && slots > 0 && !hasReturn) {
        throw this.err("a typed function must declare a return type with '-> <type>'");
      }
      throw this.err("all parameters must be typed when a return type is declared");
    }
    if (!fullyTyped) return null;

    const analysis = analyzeParameters(parsed.params);
    if (!analysis.ok) throw this.err(formatParameterIssue(analysis.issue));

    const required: Schema[] = [];
    const optional: Schema[] = [];
    let rest: Schema | undefined;
    for (const slot of analysis.layout.slots) {
      const schema = parsed.slotSchemas[slot.index]!;
      if (slot.kind === "rest") {
        rest = schema;
      } else if (slot.kind === "optional" || slot.kind === "defaulted") {
        optional.push(schema);
      } else {
        required.push(schema);
      }
    }
    const sig: Record<string, JSONType> = { required, optional };
    if (rest !== undefined) sig.rest = rest;
    sig.returns = returns!;
    return sig;
  }

  /** Assemble a structural function body (`$sig`? + `$params`? + `$return`). */
  private buildFunctionBody(
    params: Param[],
    result: JSONType,
    sig: Schema | null = null,
  ): FunctionBody {
    const body: FunctionBody = { $return: result };
    if (sig !== null) {
      body.$sig = sig;
    }
    if (params.length > 0) {
      body.$params = params;
    }
    return body;
  }

  /** Parse an expression that may carry a trailing `expr where { ... }` clause.
   * A `where` lowers directly to a canonical `$let` expression. Used at the
   * program top level and wherever a trailing clause should attach:
   * `where`-binding values, `cond`/`match` arm results, and grouped branches. */
  private parseBody(): JSONType {
    const expr = this.parseExpr();
    if (!this.eatKeyword("where")) {
      return expr;
    }
    const locals = this.parseWhereBindings();
    return buildLet(locals, expr);
  }

  private parseParams(): ParsedParams {
    this.expect("lparen", "'('");
    const params: Param[] = [];
    // `slotSchemas[i]` is the annotation on `params[i]` (a rest slot holds its
    // *element* type, already unwrapped from the `T[]` surface), or `null` when
    // unannotated.
    const slotSchemas: (Schema | null)[] = [];
    if (this.peekType() === "rparen") {
      this.advance();
      return { params, slotSchemas };
    }
    for (;;) {
      let isRest = false;
      let param: Param;
      if (this.peekType() === "dotdotdot") {
        this.advance();
        // A rest pattern `...{ x }` is unsupported: expectIdent rejects `{`.
        param = `...${this.expectIdent("rest parameter name")}`;
        isRest = true;
      } else if (this.peekType() === "lbrace") {
        param = this.parseFieldPattern();
      } else {
        const name = this.expectIdent("parameter name");
        if (this.peekType() === "question") {
          this.advance();
          param = { $param: name, $optional: true };
        } else {
          param = name;
        }
      }
      params.push(param);

      slotSchemas.push(this.parseParamAnnotation(isRest));
      if (this.peekType() === "equals") {
        if (isRest || typeof param !== "string") {
          throw this.err(
            isRest
              ? "a rest parameter cannot have a default"
              : "optional parameters and object patterns cannot have a whole-slot default",
          );
        }
        this.advance();
        params[params.length - 1] = { $param: param, $default: this.parseExpr() };
      }
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
      } else if (type === "rparen") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or ')' in parameter list");
      }
    }
    const analysis = analyzeParameters(params);
    if (!analysis.ok) throw this.err(formatParameterIssue(analysis.issue));
    return { params, slotSchemas };
  }

  /** Parse an optional `: <type>` annotation on the param slot just read. A
   * rest slot's annotation is written as `T[]` (matching how the args arrive)
   * and unwrapped one array layer to its element schema (spec §7.1). */
  private parseParamAnnotation(isRest: boolean): Schema | null {
    if (this.peekType() !== "colon") return null;
    this.advance();
    const schema = this.parseTypeExpr();
    if (!isRest) return schema;
    const element = arrayElement(schema);
    if (element === undefined) {
      throw this.err("a rest parameter's type must be an array, e.g. ...xs: T[]");
    }
    return element;
  }

  /** Parse an object-pattern parameter `{ f1, f2, }` into `{ $fields: [...] }`.
   * Rename (`{ from: f }`), nesting (`{ a: { b } }`), empty (`{}`), and
   * non-identifier fields are rejected — reserved for later (spec §3). */
  private parseFieldPattern(): FieldPattern {
    this.expect("lbrace", "'{' to begin object pattern");
    if (this.peekType() === "rbrace") {
      throw this.err("empty object pattern '{}' is not supported");
    }
    const fields: FieldPattern["$fields"] = [];
    for (;;) {
      const name = this.expectIdent("field name in object pattern");
      if (this.peekType() === "colon") {
        throw this.err("field rename/nesting in object patterns is not supported");
      }
      if (this.peekType() === "question") {
        this.advance();
        fields.push({ $field: name, $optional: true });
      } else if (this.peekType() === "equals") {
        this.advance();
        fields.push({ $field: name, $default: this.parseExpr() });
      } else {
        fields.push(name);
      }
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
        if (this.peekType() === "rbrace") {
          this.advance();
          break;
        }
      } else if (type === "rbrace") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or '}' in object pattern");
      }
    }
    return { $fields: fields };
  }

  /** Parse the `{ name: value, ... }` block of a `where` clause (`where`
   * already consumed), returning the locals in source order. */
  private parseWhereBindings(): [string, JSONType][] {
    this.expect("lbrace", "'{' after 'where'");
    const locals: [string, JSONType][] = [];
    const names = new Set<string>();
    if (this.peekType() === "rbrace") {
      throw this.err("empty 'where' block: at least one binding is required");
    }
    for (;;) {
      const name = this.expectIdent("binding name");
      if (names.has(name)) {
        throw this.err(`duplicate 'where' binding ${JSON.stringify(name)}`);
      }
      names.add(name);
      this.expect("colon", "':' after binding name");
      locals.push([name, this.parseBody()]);
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
        if (this.peekType() === "rbrace") break;
      } else if (type === "rbrace") {
        break;
      } else {
        throw this.err("expected ',' or '}' in where-bindings");
      }
    }
    this.expect("rbrace", "'}'");
    return locals;
  }

  // ----- control flow (spec section 7) -----

  private parseIf(): JSONType {
    const cond = this.parseExpr();
    this.expectKeyword("then");
    // `where` has lower precedence than `if`: an unparenthesized trailing
    // clause belongs to the body containing the whole conditional, not to one
    // of its open-ended branches. A branch-local clause must therefore be
    // parenthesized, and the grouped primary's `parseBody` consumes it there.
    const then = this.parseExpr();
    this.expectKeyword("else");
    const els = this.parseExpr();
    return { $if: cond, $then: then, $else: els };
  }

  private parseCond(): JSONType {
    this.expect("lbrace", "'{' after 'cond'");
    const [arms, elseVal] = this.parseArms();
    const map: Record<string, JSONType> = {
      $cond: arms.map(([c, r]) => [c, r]),
    };
    if (elseVal !== undefined) map.$else = elseVal;
    return map;
  }

  private parseMatch(): JSONType {
    const subject = this.parseExpr();
    this.expect("lbrace", "'{' after match subject");
    const [arms, elseVal] = this.parseArms();
    const map: Record<string, JSONType> = {
      $match: subject,
      $cases: arms.map(([c, r]) => [c, r]),
    };
    if (elseVal === undefined) {
      throw this.err("match requires an 'else:' arm");
    }
    map.$else = elseVal;
    return map;
  }

  /** Parse the shared `cond`/`match` arm block up to and including the closing
   * `}`. `else: expr` becomes the optional else value; every other
   * `expr: expr` arm is returned in order. */
  private parseArms(): [[JSONType, JSONType][], JSONType | undefined] {
    const arms: [JSONType, JSONType][] = [];
    let elseVal: JSONType | undefined;
    if (this.peekType() === "rbrace") {
      this.advance();
      return [arms, elseVal];
    }
    for (;;) {
      if (this.eatKeyword("else")) {
        this.expect("colon", "':' after 'else'");
        elseVal = this.parseBody();
      } else {
        const c = this.parseExpr();
        this.expect("colon", "':' in arm");
        arms.push([c, this.parseBody()]);
      }
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
        if (this.peekType() === "rbrace") {
          this.advance();
          break;
        }
      } else if (type === "rbrace") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or '}' between arms");
      }
    }
    return [arms, elseVal];
  }

  // ----- effects: do-notation & handle (shorthand-spec §13) -----

  /** `do { entry, ... }` where each entry is `ident <- expr` (effect binding),
   * `ident : expr` (pure binding), or a bare expression. A non-final bare
   * expression is an effect run only for its side effect (its result is
   * discarded, like Haskell's `e >> rest`); the final bare expression is the
   * block's result. Desugars to nested `bind(expr, k)` calls; see `desugarDo`. */
  private parseDo(): JSONType {
    // `do` already consumed.
    this.expect("lbrace", "'{' after 'do'");
    if (this.peekType() === "rbrace") {
      throw this.err("empty 'do' block: it must end with a result expression");
    }
    const entries: DoEntry[] = [];
    const pureNames = new Set<string>();
    for (;;) {
      const entry = this.parseDoEntry();
      if (entry.kind === "pure") {
        if (pureNames.has(entry.name)) {
          throw this.err(`duplicate pure 'do' binding ${JSON.stringify(entry.name)}`);
        }
        pureNames.add(entry.name);
      } else {
        // Each effect/discard starts a nested continuation, so a later pure run
        // is a new lexical scope and may shadow names from an earlier run.
        pureNames.clear();
      }
      entries.push(entry);
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
        if (this.peekType() === "rbrace") {
          this.advance();
          break;
        }
      } else if (type === "rbrace") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or '}' in do block");
      }
    }
    return this.desugarDo(entries);
  }

  private parseDoEntry(): DoEntry {
    const t = this.peek();
    if (t.type === "ident") {
      const after = this.tokens[this.pos + 1]?.tok;
      // `ident : expr` — pure (lazy-local) binding.
      if (after?.type === "colon") {
        this.advance(); // ident
        this.advance(); // colon
        return { kind: "pure", name: t.value, value: this.parseBody() };
      }
      // `ident <- expr` — effect binding. `<-` is not a lexer token (that would
      // break `x < -1`); we require an `lt` immediately followed by an adjacent
      // `minus` (same line, next column), only in this position.
      if (this.isLtMinusAt(this.pos + 1)) {
        this.advance(); // ident
        this.advance(); // lt
        this.advance(); // minus
        return { kind: "effect", name: t.value, value: this.parseExpr() };
      }
    }
    // Otherwise a bare result expression (only valid as the final entry).
    return { kind: "expr", value: this.parseBody() };
  }

  /** Whether tokens `[idx, idx+1]` are an adjacent `lt`/`minus` pair (`<-`). */
  private isLtMinusAt(idx: number): boolean {
    const a = this.tokens[idx];
    const b = this.tokens[idx + 1];
    if (a === undefined || b === undefined) return false;
    if (a.tok.type !== "lt" || b.tok.type !== "minus") return false;
    return a.line === b.line && b.col === a.col + 1;
  }

  /** Lower do-entries to a `bind` spine. An effect binding `x <- e` becomes
   * `bind(e, (x) => rest)`; a non-final bare expression `e` (a discard) becomes
   * `bind(e, () => rest)` — a zero-param continuation, so the effect runs and
   * its result is dropped. Each consecutive pure run wraps the remaining
   * expression in a canonical `$let`. */
  private desugarDo(entries: DoEntry[]): JSONType {
    const last = entries[entries.length - 1]!;
    if (last.kind !== "expr") {
      throw this.err("a do block must end with a result expression, not a binding");
    }
    const [leading, restIdx] = collectDoPures(entries, 0);
    const chain = this.buildDoChain(entries, restIdx);
    return leading.length === 0 ? chain : buildLet(leading, chain);
  }

  /** Build the expression for `entries[i..]`, where `entries[i]` is an effect
   * binding, a discard (non-final bare expression), or the final result
   * expression (any leading pures already consumed). */
  private buildDoChain(entries: DoEntry[], i: number): JSONType {
    const entry = entries[i]!;
    // The final entry is the bare result expression (guaranteed by `desugarDo`).
    if (i === entries.length - 1) return (entry as { value: JSONType }).value;
    // A non-final entry is an effect binding (`x <- e`) or a discard (bare `e`).
    // Both lower to `bind(e, k)`; `k` binds the result to `x` for an effect
    // binding, or takes no parameter for a discard. Following pures wrap the
    // continuation result in `$let`.
    const [pures, nextIdx] = collectDoPures(entries, i + 1);
    const rest = this.buildDoChain(entries, nextIdx);
    const result = pures.length === 0 ? rest : buildLet(pures, rest);
    const params: Param[] = entry.kind === "effect" ? [entry.name] : [];
    const k = this.buildFunctionBody(params, result);
    return { $call: "bind", $args: [entry.value, k] };
  }

  /** `handle <task> (returns <type>)? with { "name": clause, ... }` lowers to the
   * partial two-argument or total annotated three-argument `handle` call.
   * Clause keys follow data-object key rules (dotted names like `io.readLine`
   * and the `*` wildcard need quotes). */
  private parseHandle(): JSONType {
    // `handle` already consumed.
    const task = this.parseExpr();
    let annotation: Schema | null = null;
    if (this.eatKeyword("returns")) {
      annotation = this.parseTypeExpr();
    }
    this.expectKeyword("with");
    this.expect("lbrace", "'{' after 'with'");
    const handlers = this.parseDataObject();
    return {
      $call: "handle",
      $args: annotation === null ? [task, handlers] : [task, handlers, { $raw: annotation }],
    };
  }

  // ----- raw JSON islands (spec section 3) -----

  private parseRaw(): JSONType {
    return { $raw: this.parseRawJson() };
  }

  /** Parse a strict-JSON value (quoted keys, no shorthand) for a `raw` island. */
  private parseRawJson(): JSONType {
    const t = this.peek();
    switch (t.type) {
      case "num":
        this.advance();
        return t.value;
      case "minus": {
        this.advance();
        const n = this.peek();
        if (n.type === "num") {
          this.advance();
          return -n.value;
        }
        throw this.err(`expected number after '-', found ${describe(n)}`);
      }
      case "str":
        this.advance();
        return t.value;
      case "ident":
        this.advance();
        switch (t.value) {
          case "true":
            return true;
          case "false":
            return false;
          case "null":
            return null;
          default:
            throw this.err(`invalid token '${t.value}' in raw JSON`);
        }
      case "lbracket": {
        this.advance();
        const els: JSONType[] = [];
        if (this.peekType() === "rbracket") {
          this.advance();
          return els;
        }
        for (;;) {
          els.push(this.parseRawJson());
          const type = this.peekType();
          if (type === "comma") {
            this.advance();
            if (this.peekType() === "rbracket") {
              this.advance();
              break;
            }
          } else if (type === "rbracket") {
            this.advance();
            break;
          } else {
            throw this.err("expected ',' or ']' in raw JSON array");
          }
        }
        return els;
      }
      case "lbrace": {
        this.advance();
        const map: Record<string, JSONType> = {};
        if (this.peekType() === "rbrace") {
          this.advance();
          return map;
        }
        for (;;) {
          const k = this.peek();
          if (k.type !== "str") {
            throw this.err(`raw JSON object keys must be quoted strings, found ${describe(k)}`);
          }
          this.advance();
          this.expect("colon", "':' in raw JSON object");
          map[k.value] = this.parseRawJson();
          const type = this.peekType();
          if (type === "comma") {
            this.advance();
            if (this.peekType() === "rbrace") {
              this.advance();
              break;
            }
          } else if (type === "rbrace") {
            this.advance();
            break;
          } else {
            throw this.err("expected ',' or '}' in raw JSON object");
          }
        }
        return map;
      }
      default:
        throw this.err(`expected a JSON value after 'raw', found ${describe(t)}`);
    }
  }

  // ----- template strings (spec section 6) -----

  private lowerTemplate(parts: TemplatePart[]): JSONType {
    const segs: JSONType[] = [];
    for (const part of parts) {
      if (part.kind === "lit") {
        // Empty literal spans (adjacent holes, or leading/trailing) contribute
        // nothing.
        if (part.value !== "") segs.push(part.value);
      } else {
        segs.push(parseExpression(part.value));
      }
    }
    // Degenerate forms normalize: no segments -> "", single -> itself.
    if (segs.length === 0) return "";
    if (segs.length === 1) return segs[0]!;
    return fncall("strcat", segs);
  }

  private parseCallArgs(): ParsedSpreadList {
    // `(` already consumed.
    return this.parseSpreadList("rparen", "')'", "argument list");
  }

  /** Parse a comma-separated expression list with optional `...expr` entries. */
  private parseSpreadList(
    close: "rbracket" | "rparen",
    expectedClose: string,
    what: string,
  ): ParsedSpreadList {
    const parts: SpreadPart[] = [];
    let plain: JSONType[] = [];
    let hasSpread = false;
    if (this.peekType() === close) {
      this.advance();
      return { parts, hasSpread };
    }
    for (;;) {
      if (this.peekType() === "dotdotdot") {
        hasSpread = true;
        if (plain.length > 0) {
          parts.push({ kind: "plain", values: plain });
          plain = [];
        }
        this.advance();
        parts.push({ kind: "spread", value: this.parseExpr() });
      } else {
        plain.push(this.parseExpr());
      }
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
        if (this.peekType() === close) {
          this.advance();
          break;
        }
      } else if (type === close) {
        this.advance();
        break;
      } else {
        throw this.err(`expected ',' or ${expectedClose} in ${what}`);
      }
    }
    if (plain.length > 0) parts.push({ kind: "plain", values: plain });
    return { parts, hasSpread };
  }
}

// ----- lowering helpers -----

/** A parsed parameter list plus its per-slot type annotations (§4.2). */
type ParsedParams = {
  params: Param[];
  // Parallel to `params`; `null` at unannotated slots. A rest slot holds its
  // element schema (unwrapped from the surface `T[]`).
  slotSchemas: (Schema | null)[];
};

/** One parsed entry of a `do` block, before desugaring. */
type DoEntry =
  | { kind: "effect"; name: string; value: JSONType } // `name <- expr`
  | { kind: "pure"; name: string; value: JSONType } // `name : expr`
  | { kind: "expr"; value: JSONType }; // bare expression: discard (non-final) or result (final)

/** Collect a run of consecutive pure (`:`) bindings starting at `i`, returning
 * them as `[name, value]` pairs plus the index of the first non-pure entry. */
function collectDoPures(entries: DoEntry[], i: number): [[string, JSONType][], number] {
  const pures: [string, JSONType][] = [];
  let j = i;
  while (j < entries.length && entries[j]!.kind === "pure") {
    const e = entries[j] as { kind: "pure"; name: string; value: JSONType };
    pures.push([e.name, e.value]);
    j++;
  }
  return [pures, j];
}

/** Build the exact canonical representation of one non-empty recursive scope. */
function buildLet(bindings: [string, JSONType][], result: JSONType): JSONType {
  if (bindings.length === 0) {
    throw new Error("internal parser error: cannot build an empty $let");
  }
  return { $let: Object.fromEntries(bindings), $in: result };
}

function fncall(name: string, args: JSONType[]): JSONType {
  return { $call: name, $args: args };
}

/** Primitive values and plain variable reads are safe to repeat in the
 * canonical lowering. All other interior chain operands are memoized in a
 * synthetic `$let` binding. */
function isRepeatSafeComparisonOperand(value: JSONType): boolean {
  if (value === null || typeof value !== "object") return true;
  return !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$var === "string";
}

/** Conservatively reserve every string in the operands. This includes variable
 * and binding names even when they occur inside templates, nested functions,
 * or raw data, making the synthetic `$let` hygienic without a separate
 * shorthand AST or free-variable analysis. */
function collectStrings(values: JSONType[]): Set<string> {
  const strings = new Set<string>();
  const visit = (value: JSONType): void => {
    if (typeof value === "string") {
      strings.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        strings.add(key);
        visit(item);
      }
    }
  };
  for (const value of values) visit(value);
  return strings;
}

function freshComparisonTemp(used: Set<string>): string {
  for (let index = 0; ; index++) {
    const candidate = `${COMPARISON_TEMP_PREFIX}${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function plainValues(parts: SpreadPart[]): JSONType[] {
  return parts.flatMap((part) => (part.kind === "plain" ? part.values : []));
}

/** Lower ordered list segments to one variadic `concat`. A sole call spread can
 * be passed directly to `apply`, whose second argument performs array validation. */
function lowerSpreadParts(parts: SpreadPart[], directSoleSpread: boolean): JSONType {
  if (directSoleSpread && parts.length === 1 && parts[0]!.kind === "spread") {
    return parts[0]!.value;
  }
  return fncall(
    "concat",
    parts.map((part) => (part.kind === "plain" ? part.values : part.value)),
  );
}

/** Move a non-empty run of ordinary object fields into the ordered chunk list. */
function flushObjectMap(
  map: Record<string, JSONType>,
  chunks: ObjectChunk[],
): Record<string, JSONType> {
  if (Object.keys(map).length > 0) chunks.push({ kind: "plain", value: map });
  return {};
}

/** Left-fold ordered object chunks. An initial spread is merged over `{}` so a
 * spread-only literal still validates its operand as an object. */
function lowerObjectChunks(chunks: ObjectChunk[]): JSONType {
  if (chunks.length === 0) return {};
  const first = chunks[0]!;
  let value: JSONType =
    first.kind === "spread" && chunks.length === 1
      ? fncall("merge", [{}, first.value])
      : first.value;
  for (let i = 1; i < chunks.length; i++) {
    value = fncall("merge", [value, chunks[i]!.value]);
  }
  return value;
}

/** Append an argument to an existing `{ "$call": name, "$args": [...] }` call
 * node. Used to flatten a run of `++` into one variadic `strcat`. */
function pushArg(call: JSONType, arg: JSONType): void {
  if (call !== null && typeof call === "object" && !Array.isArray(call)) {
    const args = (call as Record<string, JSONType>).$args;
    if (Array.isArray(args)) args.push(arg);
  }
}

/** Build a `$get`/`$from` property-access chain from a base expression and its
 * gathered segments, following the folding rules in spec section 5. Every step
 * wraps the accumulated expression in a fresh `$get`/`$from`: a run of static
 * segments folds into one `$get` (a scalar key, or an array path when there are
 * several), and each computed key gets its own. */
function buildAccess(base: JSONType, segs: Seg[]): JSONType {
  let current = base;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i]!;
    if (seg.kind === "computed") {
      i++;
      current = { $get: seg.value, $from: current };
    } else {
      const run: JSONType[] = [];
      while (i < segs.length && segs[i]!.kind === "static") {
        run.push(segs[i]!.value);
        i++;
      }
      current = { $get: foldStatic(run), $from: current };
    }
  }
  return current;
}

/** A single static segment stays a scalar `$get`; multiple fold into an array
 * path. */
function foldStatic(run: JSONType[]): JSONType {
  return run.length === 1 ? run[0]! : run;
}
