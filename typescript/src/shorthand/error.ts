/**
 * A failure while lexing or parsing `.jfn` shorthand source.
 *
 * Carries a 1-based `line`/`col` so hosts can point at the offending token.
 * The shorthand layer is a pure surface concern (text <-> canonical JSON) and
 * never runs the interpreter, so its failures are syntactic, not evaluation
 * errors.
 */
export class ParseError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(message: string, line: number, col: number) {
    super(`parse error at ${line}:${col}: ${message}`);
    this.name = "ParseError";
    this.line = line;
    this.col = col;
  }
}
