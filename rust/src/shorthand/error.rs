use std::fmt;

/// A failure while lexing or parsing `.jfn` shorthand source.
///
/// Carries a 1-based `line`/`col` so hosts can point at the offending token.
/// This is distinct from [`crate::error::EvalError`]: the shorthand layer is a
/// pure surface concern (text <-> canonical JSON) and never runs the
/// interpreter, so its failures are syntactic, not evaluation errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub col: usize,
}

impl ParseError {
    pub fn new(message: impl Into<String>, line: usize, col: usize) -> Self {
        ParseError {
            message: message.into(),
            line,
            col,
        }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "parse error at {}:{}: {}",
            self.line, self.col, self.message
        )
    }
}

impl std::error::Error for ParseError {}
