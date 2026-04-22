use std::fmt;

/// All evaluation failures bubble up as `EvalError`. The wrapped string is
/// designed to contain the same substrings the Go implementation produces, so
/// the spec suite's substring assertions pass unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalError(pub String);

impl EvalError {
    pub fn new(msg: impl Into<String>) -> Self {
        EvalError(msg.into())
    }
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EvalError {}

impl From<String> for EvalError {
    fn from(s: String) -> Self {
        EvalError(s)
    }
}

impl From<&str> for EvalError {
    fn from(s: &str) -> Self {
        EvalError(s.to_string())
    }
}
