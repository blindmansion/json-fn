/**
 * Low-level token-stream cursor shared by the term parser (`parser.ts`) and the
 * type-expression parser (`type-parser.ts`). This is the "shared helpers" seam
 * described in the type-parsing plan §2: pure token navigation with no grammar.
 *
 * Both parsers subclass `TokenCursor` over the *same* token array. A type parser
 * is spun up mid-parse at a given `pos`, advances the shared array, and the term
 * parser resyncs to where types left off via `position()`.
 */

import { ParseError } from "./error";
import type { Tok, TokPunct, Token } from "./lexer";

export class TokenCursor {
  protected tokens: Token[];
  protected pos: number;

  constructor(tokens: Token[], pos = 0) {
    this.tokens = tokens;
    this.pos = pos;
  }

  /** The cursor's current index, so a spun-up sub-parser can hand control back. */
  position(): number {
    return this.pos;
  }

  protected peek(): Tok {
    return this.tokens[this.pos]!.tok;
  }

  protected peek2(): Tok {
    return this.tokens[this.pos + 1]?.tok ?? { type: "eof" };
  }

  protected peekType(): Tok["type"] {
    return this.peek().type;
  }

  protected advance(): Tok {
    const t = this.tokens[this.pos]!.tok;
    if (this.pos + 1 < this.tokens.length) this.pos++;
    return t;
  }

  protected err(message: string): ParseError {
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

  protected isKeyword(kw: string): boolean {
    const t = this.peek();
    return t.type === "ident" && t.value === kw;
  }

  protected eatKeyword(kw: string): boolean {
    if (this.isKeyword(kw)) {
      this.advance();
      return true;
    }
    return false;
  }

  protected expectKeyword(kw: string): void {
    if (!this.eatKeyword(kw)) {
      throw this.err(`expected '${kw}', found ${describe(this.peek())}`);
    }
  }

  protected expectIdent(what: string): string {
    const t = this.peek();
    if (t.type === "ident") {
      this.advance();
      return t.value;
    }
    throw this.err(`expected ${what}, found ${describe(t)}`);
  }
}

/** Human-readable token description for error messages. */
export function describe(tok: Tok): string {
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
