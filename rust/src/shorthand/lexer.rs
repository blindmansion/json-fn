//! Hand-written scanner: `.jfn` source text -> a flat token stream.
//!
//! Kept deliberately hand-rolled (no regex, no generator) so its behavior can
//! be mirrored byte-for-byte across the Go / Python / TypeScript ports, the
//! same way `jsonc.rs` mirrors Go's `StripJSONC`.

use serde_json::Number;

use super::error::ParseError;

/// A lexical token. String and number literals carry their *decoded* value
/// (escapes resolved), so the parser never re-decodes.
#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Num(Number),
    Str(String),
    Ident(String),
    /// A backtick template already split into literal spans and raw hole
    /// sources. The parser recursively parses each hole's source string.
    Template(Vec<TemplatePart>),

    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Comma,
    Colon,
    Dot,
    DotDotDot, // ...  (rest parameter)
    Arrow,     // ->   (cond/match arm)
    FatArrow,  // =>   (function literal)
    Amp,       // &    (function reference)

    Bang, // !
    Plus,
    PlusPlus, // ++
    Minus,
    Star,
    Slash,
    Percent,

    EqEq,  // ==
    BangEq, // !=
    Lt,
    LtEq,
    Gt,
    GtEq,

    AndAnd, // &&
    OrOr,   // ||

    Eof,
}

/// One piece of a backtick template: a literal span or a `${ ... }` hole whose
/// raw (undecoded) expression source is parsed later.
#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePart {
    Lit(String),
    Hole(String),
}

/// A token plus its 1-based source position (start of the token).
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub line: usize,
    pub col: usize,
}

struct Lexer {
    chars: Vec<char>,
    i: usize,
    line: usize,
    col: usize,
}

/// Tokenize `src`, returning tokens terminated by a single [`Tok::Eof`].
pub fn lex(src: &str) -> Result<Vec<Token>, ParseError> {
    let mut lx = Lexer {
        chars: src.chars().collect(),
        i: 0,
        line: 1,
        col: 1,
    };
    lx.run()
}

impl Lexer {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.i + 1).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.chars.get(self.i).copied()?;
        self.i += 1;
        if c == '\n' {
            self.line += 1;
            self.col = 1;
        } else {
            self.col += 1;
        }
        Some(c)
    }

    fn err(&self, msg: impl Into<String>) -> ParseError {
        ParseError::new(msg, self.line, self.col)
    }

    fn run(&mut self) -> Result<Vec<Token>, ParseError> {
        let mut out = Vec::new();
        loop {
            self.skip_trivia();
            let line = self.line;
            let col = self.col;
            let Some(c) = self.peek() else {
                out.push(Token {
                    tok: Tok::Eof,
                    line,
                    col,
                });
                return Ok(out);
            };
            let tok = self.next_token(c)?;
            out.push(Token { tok, line, col });
        }
    }

    /// Skip whitespace and `// ...` line comments. Comment *attachment* to
    /// `$comment` is deferred (spec sections 1 and 12), so comments are simply
    /// discarded here.
    fn skip_trivia(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => {
                    self.bump();
                }
                Some('/') if self.peek2() == Some('/') => {
                    while let Some(c) = self.peek() {
                        if c == '\n' {
                            break;
                        }
                        self.bump();
                    }
                }
                _ => return,
            }
        }
    }

    fn next_token(&mut self, c: char) -> Result<Tok, ParseError> {
        match c {
            '0'..='9' => self.lex_number(),
            '"' => self.lex_string(),
            '`' => self.lex_template(),
            c if is_ident_start(c) => Ok(self.lex_ident()),
            _ => self.lex_symbol(c),
        }
    }

    fn lex_symbol(&mut self, c: char) -> Result<Tok, ParseError> {
        self.bump();
        let n = self.peek();
        let tok = match c {
            '(' => Tok::LParen,
            ')' => Tok::RParen,
            '[' => Tok::LBracket,
            ']' => Tok::RBracket,
            '{' => Tok::LBrace,
            '}' => Tok::RBrace,
            ',' => Tok::Comma,
            ':' => Tok::Colon,
            '.' => {
                if n == Some('.') && self.peek2() == Some('.') {
                    self.bump();
                    self.bump();
                    Tok::DotDotDot
                } else {
                    Tok::Dot
                }
            }
            '+' => {
                if n == Some('+') {
                    self.bump();
                    Tok::PlusPlus
                } else {
                    Tok::Plus
                }
            }
            '-' => {
                if n == Some('>') {
                    self.bump();
                    Tok::Arrow
                } else {
                    Tok::Minus
                }
            }
            '*' => Tok::Star,
            '/' => Tok::Slash,
            '%' => Tok::Percent,
            '!' => {
                if n == Some('=') {
                    self.bump();
                    Tok::BangEq
                } else {
                    Tok::Bang
                }
            }
            '=' => {
                if n == Some('=') {
                    self.bump();
                    Tok::EqEq
                } else if n == Some('>') {
                    self.bump();
                    Tok::FatArrow
                } else {
                    return Err(self.err("unexpected '='; use '==' or '=>'"));
                }
            }
            '<' => {
                if n == Some('=') {
                    self.bump();
                    Tok::LtEq
                } else {
                    Tok::Lt
                }
            }
            '>' => {
                if n == Some('=') {
                    self.bump();
                    Tok::GtEq
                } else {
                    Tok::Gt
                }
            }
            '&' => {
                if n == Some('&') {
                    self.bump();
                    Tok::AndAnd
                } else {
                    Tok::Amp
                }
            }
            '|' => {
                if n == Some('|') {
                    self.bump();
                    Tok::OrOr
                } else {
                    return Err(self.err("unexpected '|'; use '||'"));
                }
            }
            other => return Err(self.err(format!("unexpected character '{other}'"))),
        };
        Ok(tok)
    }

    fn lex_ident(&mut self) -> Tok {
        let mut s = String::new();
        while let Some(c) = self.peek() {
            if is_ident_continue(c) {
                s.push(c);
                self.bump();
            } else {
                break;
            }
        }
        Tok::Ident(s)
    }

    fn lex_number(&mut self) -> Result<Tok, ParseError> {
        let mut s = String::new();
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                s.push(c);
                self.bump();
            } else {
                break;
            }
        }
        let mut is_float = false;
        // Fractional part only if a digit follows the '.', otherwise the '.'
        // is a property-access Dot (e.g. `items[0].name`).
        if self.peek() == Some('.') && self.peek2().is_some_and(|c| c.is_ascii_digit()) {
            is_float = true;
            s.push('.');
            self.bump();
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    s.push(c);
                    self.bump();
                } else {
                    break;
                }
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            is_float = true;
            s.push('e');
            self.bump();
            if matches!(self.peek(), Some('+' | '-')) {
                s.push(self.peek().unwrap());
                self.bump();
            }
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    s.push(c);
                    self.bump();
                } else {
                    break;
                }
            }
        }

        let num = if is_float {
            let f: f64 = s
                .parse()
                .map_err(|_| self.err(format!("invalid number literal '{s}'")))?;
            Number::from_f64(f)
                .ok_or_else(|| self.err(format!("number literal '{s}' is not finite")))?
        } else if let Ok(n) = s.parse::<i64>() {
            Number::from(n)
        } else {
            // Integer too large for i64: fall back to f64.
            let f: f64 = s
                .parse()
                .map_err(|_| self.err(format!("invalid number literal '{s}'")))?;
            Number::from_f64(f)
                .ok_or_else(|| self.err(format!("number literal '{s}' is not finite")))?
        };
        Ok(Tok::Num(num))
    }

    fn lex_string(&mut self) -> Result<Tok, ParseError> {
        self.bump(); // opening quote
        let mut s = String::new();
        loop {
            match self.peek() {
                None => return Err(self.err("unterminated string literal")),
                Some('"') => {
                    self.bump();
                    return Ok(Tok::Str(s));
                }
                Some('\\') => {
                    self.bump();
                    let esc = self.read_escape('"')?;
                    s.push_str(&esc);
                }
                Some(c) => {
                    s.push(c);
                    self.bump();
                }
            }
        }
    }

    /// Read a JSON-style escape sequence (the leading backslash already
    /// consumed). `quote` is the closing delimiter for context in errors.
    fn read_escape(&mut self, _quote: char) -> Result<String, ParseError> {
        let Some(c) = self.peek() else {
            return Err(self.err("unterminated escape sequence"));
        };
        self.bump();
        let out = match c {
            '"' => '"'.to_string(),
            '\\' => '\\'.to_string(),
            '/' => '/'.to_string(),
            'b' => '\u{0008}'.to_string(),
            'f' => '\u{000C}'.to_string(),
            'n' => '\n'.to_string(),
            'r' => '\r'.to_string(),
            't' => '\t'.to_string(),
            'u' => {
                let cp = self.read_hex4()?;
                if (0xD800..=0xDBFF).contains(&cp) {
                    // High surrogate: expect a "\uXXXX" low surrogate.
                    if self.peek() == Some('\\') && self.peek2() == Some('u') {
                        self.bump();
                        self.bump();
                        let low = self.read_hex4()?;
                        if (0xDC00..=0xDFFF).contains(&low) {
                            let combined =
                                0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                            char::from_u32(combined)
                                .unwrap_or('\u{FFFD}')
                                .to_string()
                        } else {
                            return Err(self.err("invalid low surrogate in \\u escape"));
                        }
                    } else {
                        return Err(self.err("unpaired high surrogate in \\u escape"));
                    }
                } else {
                    char::from_u32(cp).unwrap_or('\u{FFFD}').to_string()
                }
            }
            other => return Err(self.err(format!("invalid escape '\\{other}'"))),
        };
        Ok(out)
    }

    fn read_hex4(&mut self) -> Result<u32, ParseError> {
        let mut v: u32 = 0;
        for _ in 0..4 {
            let Some(c) = self.peek() else {
                return Err(self.err("incomplete \\u escape"));
            };
            let d = c
                .to_digit(16)
                .ok_or_else(|| self.err("invalid hex digit in \\u escape"))?;
            v = v * 16 + d;
            self.bump();
        }
        Ok(v)
    }

    /// Lex a backtick template into literal spans + raw hole sources.
    /// Escapes handled inside literal spans: `` \` `` -> backtick, `\$` -> `$`
    /// (so `\${` yields a literal `${`), `\\` -> backslash, plus the standard
    /// JSON escapes.
    fn lex_template(&mut self) -> Result<Tok, ParseError> {
        self.bump(); // opening backtick
        let mut parts: Vec<TemplatePart> = Vec::new();
        let mut cur = String::new();
        loop {
            match self.peek() {
                None => return Err(self.err("unterminated template string")),
                Some('`') => {
                    self.bump();
                    parts.push(TemplatePart::Lit(cur));
                    return Ok(Tok::Template(parts));
                }
                Some('\\') => {
                    self.bump();
                    // `\$` -> literal `$` (covers `\${`); otherwise a JSON escape.
                    if self.peek() == Some('$') {
                        self.bump();
                        cur.push('$');
                    } else {
                        let esc = self.read_escape('`')?;
                        cur.push_str(&esc);
                    }
                }
                Some('$') if self.peek2() == Some('{') => {
                    self.bump();
                    self.bump();
                    parts.push(TemplatePart::Lit(std::mem::take(&mut cur)));
                    let raw = self.read_hole()?;
                    parts.push(TemplatePart::Hole(raw));
                }
                Some(c) => {
                    cur.push(c);
                    self.bump();
                }
            }
        }
    }

    /// Capture the raw source of a `${ ... }` hole (the `${` already consumed),
    /// consuming through the matching `}`. Tracks brace depth and skips over
    /// nested string literals so a `}` inside a string does not close the hole.
    fn read_hole(&mut self) -> Result<String, ParseError> {
        let mut raw = String::new();
        let mut depth = 1usize;
        loop {
            match self.peek() {
                None => return Err(self.err("unterminated ${ ... } template hole")),
                Some('"') => {
                    // Copy the whole string literal verbatim into the raw source.
                    raw.push('"');
                    self.bump();
                    loop {
                        match self.peek() {
                            None => return Err(self.err("unterminated string in template hole")),
                            Some('\\') => {
                                raw.push('\\');
                                self.bump();
                                if let Some(c) = self.peek() {
                                    raw.push(c);
                                    self.bump();
                                }
                            }
                            Some('"') => {
                                raw.push('"');
                                self.bump();
                                break;
                            }
                            Some(c) => {
                                raw.push(c);
                                self.bump();
                            }
                        }
                    }
                }
                Some('{') => {
                    depth += 1;
                    raw.push('{');
                    self.bump();
                }
                Some('}') => {
                    depth -= 1;
                    self.bump();
                    if depth == 0 {
                        return Ok(raw);
                    }
                    raw.push('}');
                }
                Some(c) => {
                    raw.push(c);
                    self.bump();
                }
            }
        }
    }
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c.is_ascii_alphabetic()
}

fn is_ident_continue(c: char) -> bool {
    c == '_' || c.is_ascii_alphanumeric()
}
