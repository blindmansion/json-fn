/**
 * Recursive-descent + precedence-climbing parser that lowers `.jfn` shorthand
 * directly to canonical json-fn JSON. There is no separate shorthand AST: the
 * canonical JSON *is* the tree, and the lowering rules from
 * `docs/shorthand-spec.md` are applied inline.
 */

import type { JSONType, Param, FieldPattern } from "../types";
import { ParseError } from "./error";
import { lex } from "./lexer";
import type { TemplatePart, Tok, TokPunct, Token } from "./lexer";

/** Parse a full `.jfn` expression, returning canonical json-fn JSON. */
export function parse(src: string): JSONType {
  const tokens = lex(src);
  const p = new Parser(tokens);
  const v = p.parseExpr();
  p.expect("eof", "end of input");
  return v;
}

/** One property-access step gathered during postfix parsing. */
type Seg =
  | { kind: "static"; value: JSONType } // literal key/index that folds into a `$get` path
  | { kind: "computed"; value: JSONType }; // computed key that breaks a static run

const COMPARISON_OPS: Partial<Record<TokPunct, string>> = {
  eqeq: "$eq",
  bangeq: "$neq",
  lt: "$lt",
  lteq: "$lte",
  gt: "$gt",
  gteq: "$gte",
};

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Tok {
    return this.tokens[this.pos]!.tok;
  }

  private peekType(): Tok["type"] {
    return this.peek().type;
  }

  private advance(): Tok {
    const t = this.tokens[this.pos]!.tok;
    if (this.pos + 1 < this.tokens.length) this.pos++;
    return t;
  }

  private err(message: string): ParseError {
    const t = this.tokens[this.pos]!;
    return new ParseError(message, t.line, t.col);
  }

  expect(type: TokPunct, what: string): void {
    if (this.peekType() === type) {
      this.advance();
    } else {
      throw this.err(`expected ${what}, found ${describe(this.peek())}`);
    }
  }

  private isKeyword(kw: string): boolean {
    const t = this.peek();
    return t.type === "ident" && t.value === kw;
  }

  private eatKeyword(kw: string): boolean {
    if (this.isKeyword(kw)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectKeyword(kw: string): void {
    if (!this.eatKeyword(kw)) {
      throw this.err(`expected '${kw}', found ${describe(this.peek())}`);
    }
  }

  private expectIdent(what: string): string {
    const t = this.peek();
    if (t.type === "ident") {
      this.advance();
      return t.value;
    }
    throw this.err(`expected ${what}, found ${describe(t)}`);
  }

  // ----- expression precedence ladder (spec section 6) -----

  parseExpr(): JSONType {
    return this.parseOr();
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
    const parts = [this.parseCmp()];
    while (this.peekType() === "andand") {
      this.advance();
      parts.push(this.parseCmp());
    }
    return parts.length === 1 ? parts[0]! : { $and: parts };
  }

  private parseCmp(): JSONType {
    const left = this.parseAdd();
    const key = COMPARISON_OPS[this.peekType() as TokPunct];
    if (key === undefined) return left;
    this.advance();
    const right = this.parseAdd();
    // Non-associative: reject `a < b < c`.
    if (COMPARISON_OPS[this.peekType() as TokPunct] !== undefined) {
      throw this.err("comparison operators are non-associative");
    }
    return { [key]: [left, right] };
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
      return { $not: this.parseUnary() };
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
        const args = this.parseCallArgs();
        val = { $fn: [callee, ...args] };
        name = null;
      } else if (type === "dot" || type === "lbracket") {
        const segs = this.gatherAccess();
        const base: JSONType = name !== null ? { $var: name } : val;
        name = null;
        val = buildAccess(base, segs);
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
            throw this.err("'where { ... }' is only valid immediately after a function body");
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
      const e = this.parseExpr();
      this.expect("rparen", "')'");
      return { $fn: e };
    }
    const name = this.expectIdent("function name after '&'");
    return { $fn: name };
  }

  private parseArray(): JSONType {
    // `[` already consumed.
    const els: JSONType[] = [];
    if (this.peekType() === "rbracket") {
      this.advance();
      return els;
    }
    for (;;) {
      els.push(this.parseExpr());
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
        throw this.err("expected ',' or ']' in array");
      }
    }
    return els;
  }

  private parseDataObject(): JSONType {
    // `{` already consumed. Keys are literal data; values are evaluated.
    const map: Record<string, JSONType> = {};
    if (this.peekType() === "rbrace") {
      this.advance();
      return map;
    }
    for (;;) {
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
        throw this.err("expected ',' or '}' in data object");
      }
    }
    return map;
  }

  // ----- function literals & let-bindings (spec section 8) -----

  /** Peek whether the `(` at the cursor begins `( params ) =>`. */
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
          return this.tokens[i + 1]?.tok.type === "fatarrow";
        }
      }
      i++;
    }
  }

  private parseFuncLit(): JSONType {
    const params = this.parseParams();
    this.expect("fatarrow", "'=>'");
    // Body is `expr` optionally followed by a `where { ... }` clause supplying
    // the (lazy, order-independent) locals. `where` is not an operator, so
    // `parseExpr` stops before it and we consume the clause here.
    const ret = this.parseExpr();
    const locals = this.eatKeyword("where") ? this.parseWhereBindings() : [];
    // A function body inlines its `where` locals directly (params + locals +
    // $return); no IIFE needed since this scope already exists.
    return this.buildScope(params, locals, ret);
  }

  /** Assemble a scope map (`$params`? + locals + `$return`) shared by function
   * literals and expression-level `where` (spec section 8). */
  private buildScope(
    params: Param[],
    locals: [string, JSONType][],
    ret: JSONType,
  ): Record<string, JSONType> {
    const map: Record<string, JSONType> = {};
    if (params.length > 0) {
      map.$params = params;
    }
    for (const [k, v] of locals) {
      map[k] = v;
    }
    map.$return = ret;
    return map;
  }

  /** Parse an expression that may carry a trailing `expr where { ... }` clause.
   * With a `where`, the expression lowers to a zero-arg IIFE over a scope so the
   * existing `buildScope`/`callJSONFunction` machinery evaluates the locals —
   * no evaluator changes (spec section 8). Used wherever a trailing `where`
   * should attach: `where`-binding values, `cond`/`match` arm results, and
   * `if/then/else` branches. */
  private parseBody(): JSONType {
    const expr = this.parseExpr();
    if (!this.eatKeyword("where")) {
      return expr;
    }
    const locals = this.parseWhereBindings();
    return { $fn: [this.buildScope([], locals, expr)] };
  }

  private parseParams(): Param[] {
    this.expect("lparen", "'('");
    const params: Param[] = [];
    if (this.peekType() === "rparen") {
      this.advance();
      return params;
    }
    for (;;) {
      if (this.peekType() === "dotdotdot") {
        this.advance();
        // A rest pattern `...{ x }` is unsupported: expectIdent rejects `{`.
        params.push(`...${this.expectIdent("rest parameter name")}`);
      } else if (this.peekType() === "lbrace") {
        params.push(this.parseFieldPattern());
      } else {
        params.push(this.expectIdent("parameter name"));
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
    return params;
  }

  /** Parse an object-pattern parameter `{ f1, f2, }` into `{ $fields: [...] }`.
   * Rename (`{ from: f }`), nesting (`{ a: { b } }`), empty (`{}`), and
   * non-identifier fields are rejected — reserved for later (spec §3). */
  private parseFieldPattern(): FieldPattern {
    this.expect("lbrace", "'{' to begin object pattern");
    if (this.peekType() === "rbrace") {
      throw this.err("empty object pattern '{}' is not supported");
    }
    const fields: string[] = [];
    for (;;) {
      fields.push(this.expectIdent("field name in object pattern"));
      if (this.peekType() === "colon") {
        throw this.err("field rename/nesting in object patterns is not supported");
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
    if (this.peekType() !== "rbrace") {
      for (;;) {
        const name = this.expectIdent("binding name");
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
    }
    this.expect("rbrace", "'}'");
    return locals;
  }

  // ----- control flow (spec section 7) -----

  private parseIf(): JSONType {
    const cond = this.parseExpr();
    this.expectKeyword("then");
    const then = this.parseBody();
    this.expectKeyword("else");
    const els = this.parseBody();
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
      throw this.err("match requires an 'else ->' arm");
    }
    map.$else = elseVal;
    return map;
  }

  /** Parse the shared `cond`/`match` arm block up to and including the closing
   * `}`. `else -> expr` becomes the optional else value; every other
   * `expr -> expr` arm is returned in order. */
  private parseArms(): [[JSONType, JSONType][], JSONType | undefined] {
    const arms: [JSONType, JSONType][] = [];
    let elseVal: JSONType | undefined;
    if (this.peekType() === "rbrace") {
      this.advance();
      return [arms, elseVal];
    }
    for (;;) {
      if (this.eatKeyword("else")) {
        this.expect("arrow", "'->' after 'else'");
        elseVal = this.parseBody();
      } else {
        const c = this.parseExpr();
        this.expect("arrow", "'->' in arm");
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
    for (;;) {
      entries.push(this.parseDoEntry());
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
   * its result is dropped. Pure bindings since the previous effect/discard
   * attach as that continuation's `where`-locals; pure bindings before the
   * first one wrap the whole chain in a zero-arg IIFE (like `where`). */
  private desugarDo(entries: DoEntry[]): JSONType {
    const last = entries[entries.length - 1]!;
    if (last.kind !== "expr") {
      throw this.err("a do block must end with a result expression, not a binding");
    }
    const [leading, restIdx] = collectDoPures(entries, 0);
    const chain = this.buildDoChain(entries, restIdx);
    if (leading.length > 0) {
      return { $fn: [this.buildScope([], leading, chain)] };
    }
    return chain;
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
    // binding, or takes no parameter for a discard. Following pures are `k`'s
    // `where`-locals.
    const [pures, nextIdx] = collectDoPures(entries, i + 1);
    const contBody = this.buildDoChain(entries, nextIdx);
    const params: Param[] = entry.kind === "effect" ? [entry.name] : [];
    const k = this.buildScope(params, pures, contBody);
    return { $fn: ["bind", entry.value, k] };
  }

  /** `handle <task> with { "name": clause, ... }` → `handle(task, clauses)`.
   * Clause keys follow data-object key rules (dotted names like `io.readLine`
   * and the `*` wildcard need quotes). */
  private parseHandle(): JSONType {
    // `handle` already consumed.
    const task = this.parseExpr();
    this.expectKeyword("with");
    this.expect("lbrace", "'{' after 'with'");
    const handlers = this.parseDataObject();
    return { $fn: ["handle", task, handlers] };
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
        segs.push(parse(part.value));
      }
    }
    // Degenerate forms normalize: no segments -> "", single -> itself.
    if (segs.length === 0) return "";
    if (segs.length === 1) return segs[0]!;
    return fncall("strcat", segs);
  }

  private parseCallArgs(): JSONType[] {
    // `(` already consumed.
    const args: JSONType[] = [];
    if (this.peekType() === "rparen") {
      this.advance();
      return args;
    }
    for (;;) {
      args.push(this.parseExpr());
      const type = this.peekType();
      if (type === "comma") {
        this.advance();
        if (this.peekType() === "rparen") {
          this.advance();
          break;
        }
      } else if (type === "rparen") {
        this.advance();
        break;
      } else {
        throw this.err("expected ',' or ')' in argument list");
      }
    }
    return args;
  }
}

// ----- lowering helpers -----

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

function fncall(name: string, args: JSONType[]): JSONType {
  return { $fn: [name, ...args] };
}

/** Append an argument to an existing `{ "$fn": [name, ...] }` call node. Used to
 * flatten a run of `++` into one variadic `strcat`. */
function pushArg(call: JSONType, arg: JSONType): void {
  if (call !== null && typeof call === "object" && !Array.isArray(call)) {
    const fn = (call as Record<string, JSONType>).$fn;
    if (Array.isArray(fn)) fn.push(arg);
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

/** Human-readable token description for error messages. */
function describe(tok: Tok): string {
  switch (tok.type) {
    case "num":
      return `number ${tok.value}`;
    case "str":
      return `string ${JSON.stringify(tok.value)}`;
    case "ident":
      return `identifier '${tok.value}'`;
    case "template":
      return "template string";
    default:
      return `'${tok.type}'`;
  }
}
