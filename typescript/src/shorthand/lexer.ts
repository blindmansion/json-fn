/**
 * Hand-written scanner: `.jfn` source text -> a flat token stream.
 */

import { ParseError } from "./error";

/** One piece of a backtick template: a literal span or a `${ ... }` hole whose
 * raw (undecoded) expression source is parsed later. */
export type TemplatePart = { kind: "lit"; value: string } | { kind: "hole"; value: string };

/** A lexical token. String and number literals carry their decoded value
 * (escapes resolved), so the parser never re-decodes. */
export type Tok =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "ident"; value: string }
  | { type: "template"; parts: TemplatePart[] }
  | { type: TokPunct };

export type TokPunct =
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "lbrace"
  | "rbrace"
  | "comma"
  | "colon"
  | "dot"
  | "dotdotdot" // ...  (rest parameter or spread)
  | "arrow" //     ->   (function result annotation or function type)
  | "fatarrow" //  =>   (function literal)
  | "amp" //       &    (function reference)
  | "bang" //      !
  | "plus"
  | "plusplus" //  ++
  | "minus"
  | "star"
  | "slash"
  | "percent"
  | "equals" //    =    (type declaration)
  | "eqeq" //      ==
  | "bangeq" //    !=
  | "lt"
  | "lteq"
  | "gt"
  | "gteq"
  | "andand" //    &&
  | "oror" //      ||
  | "pipe" //      |    (type union)
  | "question" //  ?    (optional key, parameter, or function-type slot)
  | "eof";

/** A token plus its 1-based source position and ending line. */
export type Token = {
  tok: Tok;
  line: number;
  col: number;
  endLine: number;
};

/** Tokenize `src`, returning tokens terminated by a single `eof` token. */
export function lex(src: string): Token[] {
  return new Lexer(src).run();
}

class Lexer {
  private chars: string[];
  private i = 0;
  private line = 1;
  private col = 1;

  constructor(src: string) {
    // Iterate by Unicode code point (not UTF-16 code unit).
    this.chars = Array.from(src);
  }

  private peek(): string | undefined {
    return this.chars[this.i];
  }

  private peek2(): string | undefined {
    return this.chars[this.i + 1];
  }

  private bump(): string | undefined {
    const c = this.chars[this.i];
    if (c === undefined) return undefined;
    this.i++;
    if (c === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private err(message: string): ParseError {
    return new ParseError(message, this.line, this.col);
  }

  run(): Token[] {
    const out: Token[] = [];
    for (;;) {
      this.skipTrivia();
      const line = this.line;
      const col = this.col;
      const c = this.peek();
      if (c === undefined) {
        out.push({ tok: { type: "eof" }, line, col, endLine: line });
        return out;
      }
      const tok = this.nextToken(c);
      out.push({ tok, line, col, endLine: this.line });
    }
  }

  /** Skip whitespace plus line and non-nested block comments. Comment
   * attachment to `$comment` is deferred, so comments are discarded here. */
  private skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c !== undefined && isWhitespace(c)) {
        this.bump();
      } else if (c === "/" && this.peek2() === "/") {
        for (;;) {
          const n = this.peek();
          if (n === undefined || n === "\n") break;
          this.bump();
        }
      } else if (c === "/" && this.peek2() === "*") {
        const line = this.line;
        const col = this.col;
        this.bump();
        this.bump();
        for (;;) {
          const n = this.peek();
          if (n === undefined) {
            throw new ParseError("unterminated block comment", line, col);
          }
          if (n === "*" && this.peek2() === "/") {
            this.bump();
            this.bump();
            break;
          }
          this.bump();
        }
      } else {
        return;
      }
    }
  }

  private nextToken(c: string): Tok {
    if (isDigit(c)) return this.lexNumber();
    if (c === '"') return this.lexString();
    if (c === "`") return this.lexTemplate();
    if (isIdentStart(c)) return this.lexIdent();
    return this.lexSymbol(c);
  }

  private lexSymbol(c: string): Tok {
    this.bump();
    const n = this.peek();
    switch (c) {
      case "(":
        return { type: "lparen" };
      case ")":
        return { type: "rparen" };
      case "[":
        return { type: "lbracket" };
      case "]":
        return { type: "rbracket" };
      case "{":
        return { type: "lbrace" };
      case "}":
        return { type: "rbrace" };
      case ",":
        return { type: "comma" };
      case ":":
        return { type: "colon" };
      case ".":
        if (n === "." && this.peek2() === ".") {
          this.bump();
          this.bump();
          return { type: "dotdotdot" };
        }
        return { type: "dot" };
      case "+":
        if (n === "+") {
          this.bump();
          return { type: "plusplus" };
        }
        return { type: "plus" };
      case "-":
        if (n === ">") {
          this.bump();
          return { type: "arrow" };
        }
        return { type: "minus" };
      case "*":
        return { type: "star" };
      case "/":
        return { type: "slash" };
      case "%":
        return { type: "percent" };
      case "!":
        if (n === "=") {
          this.bump();
          return { type: "bangeq" };
        }
        return { type: "bang" };
      case "=":
        if (n === "=") {
          this.bump();
          return { type: "eqeq" };
        }
        if (n === ">") {
          this.bump();
          return { type: "fatarrow" };
        }
        // A lone `=` is the type-declaration separator (`type Name = …`); the
        // term grammar only ever uses `==`/`=>`.
        return { type: "equals" };
      case "<":
        if (n === "=") {
          this.bump();
          return { type: "lteq" };
        }
        return { type: "lt" };
      case ">":
        if (n === "=") {
          this.bump();
          return { type: "gteq" };
        }
        return { type: "gt" };
      case "&":
        if (n === "&") {
          this.bump();
          return { type: "andand" };
        }
        return { type: "amp" };
      case "|":
        if (n === "|") {
          this.bump();
          return { type: "oror" };
        }
        // A lone `|` is the type-union operator (disjoint from the term grammar,
        // which only ever asks for `||`).
        return { type: "pipe" };
      case "?":
        return { type: "question" };
      default:
        throw this.err(`unexpected character '${c}'`);
    }
  }

  private lexIdent(): Tok {
    let s = "";
    for (;;) {
      const c = this.peek();
      if (!isIdentContinue(c)) break;
      s += c;
      this.bump();
    }
    return { type: "ident", value: s };
  }

  private lexNumber(): Tok {
    let s = "";
    for (;;) {
      const c = this.peek();
      if (!isDigit(c)) break;
      s += c;
      this.bump();
    }
    // Fractional part only if a digit follows the '.', otherwise the '.' is a
    // property-access dot (e.g. `items[0].name`).
    if (this.peek() === "." && isDigit(this.peek2())) {
      s += ".";
      this.bump();
      for (;;) {
        const c = this.peek();
        if (!isDigit(c)) break;
        s += c;
        this.bump();
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      s += "e";
      this.bump();
      if (this.peek() === "+" || this.peek() === "-") {
        s += this.peek();
        this.bump();
      }
      for (;;) {
        const c = this.peek();
        if (!isDigit(c)) break;
        s += c;
        this.bump();
      }
    }

    const num = Number(s);
    if (!Number.isFinite(num)) {
      throw this.err(`number literal '${s}' is not finite`);
    }
    return { type: "num", value: num };
  }

  private lexString(): Tok {
    this.bump(); // opening quote
    let s = "";
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw this.err("unterminated string literal");
      if (c === '"') {
        this.bump();
        return { type: "str", value: s };
      }
      if (c === "\\") {
        this.bump();
        s += this.readEscape();
      } else {
        s += c;
        this.bump();
      }
    }
  }

  /** Read a JSON-style escape sequence (the leading backslash already
   * consumed). */
  private readEscape(): string {
    const c = this.peek();
    if (c === undefined) throw this.err("unterminated escape sequence");
    this.bump();
    switch (c) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\u0008";
      case "f":
        return "\u000c";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const cp = this.readHex4();
        if (cp >= 0xd800 && cp <= 0xdbff) {
          // High surrogate: expect a "\uXXXX" low surrogate.
          if (this.peek() === "\\" && this.peek2() === "u") {
            this.bump();
            this.bump();
            const low = this.readHex4();
            if (low >= 0xdc00 && low <= 0xdfff) {
              const combined = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
              return String.fromCodePoint(combined);
            }
            throw this.err("invalid low surrogate in \\u escape");
          }
          throw this.err("unpaired high surrogate in \\u escape");
        }
        return codePointToString(cp);
      }
      default:
        throw this.err(`invalid escape '\\${c}'`);
    }
  }

  private readHex4(): number {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = this.peek();
      if (c === undefined) throw this.err("incomplete \\u escape");
      const d = hexDigit(c);
      if (d === undefined) throw this.err("invalid hex digit in \\u escape");
      v = v * 16 + d;
      this.bump();
    }
    return v;
  }

  /** Lex a backtick template into literal spans + raw hole sources. Escapes
   * handled inside literal spans: `` \` `` -> backtick, `\$` -> `$` (so `\${`
   * yields a literal `${`), `\\` -> backslash, plus the standard JSON escapes. */
  private lexTemplate(): Tok {
    this.bump(); // opening backtick
    const parts: TemplatePart[] = [];
    let cur = "";
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw this.err("unterminated template string");
      if (c === "`") {
        this.bump();
        parts.push({ kind: "lit", value: cur });
        return { type: "template", parts };
      }
      if (c === "\\") {
        this.bump();
        // `\$` -> literal `$` (covers `\${`); otherwise a JSON escape.
        if (this.peek() === "$") {
          this.bump();
          cur += "$";
        } else {
          cur += this.readEscape();
        }
      } else if (c === "$" && this.peek2() === "{") {
        this.bump();
        this.bump();
        parts.push({ kind: "lit", value: cur });
        cur = "";
        parts.push({ kind: "hole", value: this.readHole() });
      } else {
        cur += c;
        this.bump();
      }
    }
  }

  /** Capture the raw source of a `${ ... }` hole (the `${` already consumed),
   * consuming through the matching `}`. Tracks brace depth and copies strings
   * and comments whole so braces inside them do not close the hole. */
  private readHole(): string {
    let raw = "";
    let depth = 1;
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw this.err("unterminated ${ ... } template hole");
      if (c === '"') {
        // Copy the whole string literal verbatim into the raw source.
        raw += '"';
        this.bump();
        for (;;) {
          const s = this.peek();
          if (s === undefined) throw this.err("unterminated string in template hole");
          if (s === "\\") {
            raw += "\\";
            this.bump();
            const next = this.peek();
            if (next !== undefined) {
              raw += next;
              this.bump();
            }
          } else if (s === '"') {
            raw += '"';
            this.bump();
            break;
          } else {
            raw += s;
            this.bump();
          }
        }
      } else if (c === "/" && this.peek2() === "/") {
        // Preserve the comment for the recursive lexer, but do not interpret a
        // brace inside it as part of the template-hole structure.
        while (this.peek() !== undefined && this.peek() !== "\n") {
          raw += this.bump();
        }
      } else if (c === "/" && this.peek2() === "*") {
        const line = this.line;
        const col = this.col;
        raw += this.bump();
        raw += this.bump();
        for (;;) {
          const n = this.peek();
          if (n === undefined) {
            throw new ParseError("unterminated block comment", line, col);
          }
          raw += this.bump();
          if (n === "*" && this.peek() === "/") {
            raw += this.bump();
            break;
          }
        }
      } else if (c === "{") {
        depth++;
        raw += "{";
        this.bump();
      } else if (c === "}") {
        depth--;
        this.bump();
        if (depth === 0) return raw;
        raw += "}";
      } else {
        raw += c;
        this.bump();
      }
    }
  }
}

function isWhitespace(c: string): boolean {
  return /\s/u.test(c);
}

function isDigit(c: string | undefined): c is string {
  return c !== undefined && c >= "0" && c <= "9";
}

function isAsciiAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

function isIdentStart(c: string): boolean {
  return c === "_" || isAsciiAlpha(c);
}

function isIdentContinue(c: string | undefined): c is string {
  return c !== undefined && (c === "_" || isAsciiAlpha(c) || isDigit(c));
}

function hexDigit(c: string): number | undefined {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 0x30;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 0x61 + 10;
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 0x41 + 10;
  return undefined;
}

/** Map a scalar code point to a string, substituting U+FFFD for values in the
 * surrogate range (which are not valid scalar values). */
function codePointToString(cp: number): string {
  if (cp >= 0xd800 && cp <= 0xdfff) return "\ufffd";
  return String.fromCodePoint(cp);
}
