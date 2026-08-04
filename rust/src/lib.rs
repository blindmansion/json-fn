//! json-fn: a tree-walking interpreter for the json-fn JSON expression language.
//!
//! This crate mirrors the Go and TypeScript reference implementations and
//! passes the shared conformance suite under `spec/cases/`.

pub mod error;
pub mod eval;
pub mod jsonc;
pub mod path;
pub mod shorthand;
pub mod stdlib;
pub mod value;

pub use error::EvalError;
pub use eval::{ExecutionLimits, ExecutionUsage, PreparedCall, call_function};
pub use jsonc::strip_jsonc;
pub use shorthand::{ParseError, parse as parse_shorthand};
pub use stdlib::{LogFn, StdlibOptions, create_stdlib, create_stdlib_with_options};
pub use value::{
    BodyMeta, BuiltinFn, FnEntry, FunctionRegistry, PureFn, Value, get_arity, json_equal, to_f64,
};
