//! `.jfn` shorthand: a bidirectional surface over canonical json-fn JSON.
//!
//! This module is a pure surface layer. `parse` lowers shorthand source text
//! to the same [`serde_json::Value`] the interpreter consumes, so a host can
//! feed the result straight into [`crate::call_function`]. The interpreter
//! itself never sees shorthand.
//!
//! Only the parse (lower) direction is implemented so far; printing (raising
//! canonical JSON back to shorthand) is tracked separately.

pub mod error;
pub mod lexer;
pub mod parser;

pub use error::ParseError;
pub use parser::parse;
