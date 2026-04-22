use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value as SerdeValue;

use crate::error::EvalError;

/// JSON value type used throughout the interpreter.
pub type Value = SerdeValue;

/// Native function that operates on its arguments only and returns a value.
/// Mirrors Go's `PureFunc`.
pub type PureFn = Arc<dyn Fn(&[Value]) -> Result<Value, EvalError> + Send + Sync>;

/// Native function that may invoke json-fn callbacks. Receives the active
/// evaluator (so it can re-enter the interpreter) and the current registry.
/// Mirrors Go's `BuiltinFunc`.
pub type BuiltinFn =
    Arc<dyn Fn(&[Value], &mut crate::eval::EvalCtx) -> Result<Value, EvalError> + Send + Sync>;

/// A json-fn function body together with metadata precomputed once at
/// registration time. Held inside `FnEntry::Body` via an `Arc` so the body
/// itself is never deep-cloned on each call.
#[derive(Debug)]
pub struct BodyMeta {
    /// The raw body — an object containing `$return` (and optionally
    /// `$params` and local function declarations).
    pub body: Value,
    /// Names of object keys whose values are themselves function bodies.
    /// Pre-scanned so `call_json_function` doesn't re-walk the body each call.
    pub local_fn_keys: Vec<String>,
}

impl BodyMeta {
    pub fn new(body: Value) -> Self {
        let local_fn_keys = match &body {
            Value::Object(obj) => obj
                .iter()
                .filter_map(|(k, v)| {
                    if k == "$return" || k == "$params" {
                        return None;
                    }
                    match v {
                        Value::Object(inner) if inner.contains_key("$return") => {
                            Some(k.clone())
                        }
                        _ => None,
                    }
                })
                .collect(),
            _ => Vec::new(),
        };
        BodyMeta { body, local_fn_keys }
    }
}

/// One entry in the function registry.
///
/// - `Pure`: side-effect-free Rust function.
/// - `Builtin`: Rust function that can call back into the interpreter (map, reduce, ...).
/// - `Body`: a json-fn function body — a JSON object containing `$return`,
///   shared by `Arc` so cloning the entry is just an atomic refcount bump.
#[derive(Clone)]
pub enum FnEntry {
    Pure { arity: i32, f: PureFn },
    Builtin { arity: i32, f: BuiltinFn },
    Body(Arc<BodyMeta>),
}

impl FnEntry {
    pub fn pure<F>(arity: i32, f: F) -> Self
    where
        F: Fn(&[Value]) -> Result<Value, EvalError> + Send + Sync + 'static,
    {
        FnEntry::Pure { arity, f: Arc::new(f) }
    }

    pub fn builtin<F>(arity: i32, f: F) -> Self
    where
        F: Fn(&[Value], &mut crate::eval::EvalCtx) -> Result<Value, EvalError> + Send + Sync + 'static,
    {
        FnEntry::Builtin { arity, f: Arc::new(f) }
    }

    /// Convenience constructor for a json-fn function body.
    pub fn body(body: Value) -> Self {
        FnEntry::Body(Arc::new(BodyMeta::new(body)))
    }
}

pub type FunctionRegistry = HashMap<String, FnEntry>;

/// Returns the arity of a function declaration, or `None` if unknown.
/// Matches Go's `GetArity` behaviour: -1 → None, otherwise the arity.
pub fn get_arity(fn_decl: &Value, registry: &FunctionRegistry) -> Option<i32> {
    match fn_decl {
        Value::Object(obj) => {
            if obj.contains_key("$return") {
                let params = obj.get("$params").and_then(|v| v.as_array());
                let Some(params) = params else { return Some(0) };
                if let Some(last) = params.last().and_then(|p| p.as_str())
                    && let Some(_rest) = last.strip_prefix("...")
                {
                    return Some((params.len() as i32) - 1);
                }
                Some(params.len() as i32)
            } else {
                None
            }
        }
        Value::String(s) => {
            let entry = registry.get(s)?;
            match entry {
                FnEntry::Pure { arity, .. } | FnEntry::Builtin { arity, .. } => {
                    if *arity < 0 { None } else { Some(*arity) }
                }
                FnEntry::Body(meta) => get_arity(&meta.body, registry),
            }
        }
        _ => None,
    }
}

/// Coerces a JSON value to `f64` if it is numeric. Mirrors Go's `toFloat64`.
pub fn to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// JavaScript-style truthiness used by `$if`, `$cond`, `$and`, `$or`, and the
/// higher-order builtins. Mirrors Go's `isTruthy`.
pub fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Deep equality with JS `===` semantics for primitives, structural equality
/// for arrays and objects. Numbers are compared as `f64` so that the spec's
/// integer-typed expectations (`42`) match the interpreter's `f64`-typed
/// results (`42.0`). Mirrors Go's `jsonEqual`.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(xf), Some(yf)) => xf == yf,
            _ => false,
        },
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter().all(|(k, v)| match y.get(k) {
                    Some(yv) => json_equal(v, yv),
                    None => false,
                })
        }
        _ => false,
    }
}

/// Order-relation used by `sortBy`. Compares numbers as `f64`, strings
/// lexicographically. Other types compare equal (returns `false`). Mirrors
/// Go's `jsonLess`.
pub fn json_less(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(xf), Some(yf)) => xf < yf,
            _ => false,
        },
        (Value::String(x), Value::String(y)) => x < y,
        _ => false,
    }
}

/// Returns `true` when the value is a function declaration: a string name or
/// an object with a `$return` key.
pub fn is_fn_declaration(v: &Value) -> bool {
    match v {
        Value::String(_) => true,
        Value::Object(obj) => obj.contains_key("$return"),
        _ => false,
    }
}

/// Builds the human-readable type tag used in error messages for
/// `Got <type>` reporting. Mirrors Go's `%T` and TS's `typeof`.
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Renders the offending expression for an `Invalid JSON expression: ...`
/// error. Mirrors Go's `exprError`.
pub fn expr_error(expr: &Value, message: &str) -> EvalError {
    let pretty = serde_json::to_string_pretty(expr).unwrap_or_else(|_| "<unprintable>".into());
    EvalError(format!("Invalid JSON expression: {pretty}. {message}"))
}
