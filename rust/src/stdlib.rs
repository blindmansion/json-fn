use std::sync::{Arc, OnceLock};

use regex::{Captures, Regex};
use serde_json::{Map, Number, Value};

use crate::error::EvalError;
use crate::value::{
    FnEntry, FunctionRegistry, get_arity, is_truthy, json_equal, json_less, scalar_equal, to_f64,
};

fn one_float(args: &[Value], name: &str) -> Result<f64, EvalError> {
    to_f64(&args[0]).ok_or_else(|| EvalError(format!("{name}: argument must be a number")))
}

fn two_floats(args: &[Value], name: &str) -> Result<(f64, f64), EvalError> {
    let a = to_f64(&args[0]);
    let b = to_f64(&args[1]);
    match (a, b) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(EvalError(format!("{name}: arguments must be numbers"))),
    }
}

/// Wraps an `f64` in `Value::Number`, choosing the integer representation
/// when the value is integer-valued. Matches Go's `encoding/json` behaviour
/// for `float64`, which serializes whole numbers without a decimal — needed
/// so the spec test expectations (e.g. `"9"` for `str(9)`) match.
fn num(n: f64) -> Value {
    if n.is_finite() && n == n.trunc() && (i64::MIN as f64..=i64::MAX as f64).contains(&n) {
        return Value::Number(Number::from(n as i64));
    }
    Value::Number(Number::from_f64(n).unwrap_or_else(|| Number::from(0)))
}

fn sorted_keys(obj: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    keys
}

/// Host-provided sink used by the `log` stdlib function.
pub type LogFn = dyn Fn(&Value, Option<&Value>) + Send + Sync + 'static;

/// Options for constructing the standard library.
#[derive(Clone, Default)]
pub struct StdlibOptions {
    /// Optional sink used by `log`. When absent, `log` is a no-op tap.
    pub logger: Option<Arc<LogFn>>,
}

/// Constructs the standard library used by the conformance tests and the
/// chess example. Mirrors Go's `CreateStdlib`.
pub fn create_stdlib() -> FunctionRegistry {
    create_stdlib_with_options(StdlibOptions::default())
}

/// Constructs the standard library with host-provided options.
pub fn create_stdlib_with_options(options: StdlibOptions) -> FunctionRegistry {
    let mut r = FunctionRegistry::new();

    // -- Arithmetic ---------------------------------------------------------
    r.insert(
        "add".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "add")?;
            Ok(num(x + y))
        }),
    );
    r.insert(
        "sub".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "sub")?;
            Ok(num(x - y))
        }),
    );
    r.insert(
        "mul".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "mul")?;
            Ok(num(x * y))
        }),
    );
    r.insert(
        "div".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "div")?;
            if y == 0.0 {
                return Err(EvalError("div: division by zero".into()));
            }
            Ok(num(x / y))
        }),
    );
    r.insert(
        "mod".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "mod")?;
            // Go uses math.Mod — IEEE remainder with the sign of x.
            Ok(num(x - (x / y).trunc() * y))
        }),
    );
    r.insert(
        "abs".into(),
        FnEntry::pure(1, |a| Ok(num(one_float(a, "abs")?.abs()))),
    );
    r.insert(
        "neg".into(),
        FnEntry::pure(1, |a| Ok(num(-one_float(a, "neg")?))),
    );
    r.insert(
        "floor".into(),
        FnEntry::pure(1, |a| Ok(num(one_float(a, "floor")?.floor()))),
    );
    r.insert(
        "ceil".into(),
        FnEntry::pure(1, |a| Ok(num(one_float(a, "ceil")?.ceil()))),
    );
    r.insert(
        "round".into(),
        FnEntry::pure(1, |a| {
            // Go's math.Round rounds half-away-from-zero. Rust's f64::round matches.
            Ok(num(one_float(a, "round")?.round()))
        }),
    );
    r.insert(
        "max".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("max: argument must be an array".into()))?;
            if arr.is_empty() {
                return Ok(num(f64::NEG_INFINITY));
            }
            let mut best = f64::NEG_INFINITY;
            for v in arr {
                let n = to_f64(v)
                    .ok_or_else(|| EvalError("max: array element is not a number".into()))?;
                if n > best {
                    best = n;
                }
            }
            Ok(num(best))
        }),
    );
    r.insert(
        "min".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("min: argument must be an array".into()))?;
            if arr.is_empty() {
                return Ok(num(f64::INFINITY));
            }
            let mut best = f64::INFINITY;
            for v in arr {
                let n = to_f64(v)
                    .ok_or_else(|| EvalError("min: array element is not a number".into()))?;
                if n < best {
                    best = n;
                }
            }
            Ok(num(best))
        }),
    );

    // -- Comparison --------------------------------------------------------
    r.insert(
        "eq".into(),
        FnEntry::pure(2, |a| Ok(Value::Bool(scalar_equal(&a[0], &a[1])))),
    );
    r.insert(
        "neq".into(),
        FnEntry::pure(2, |a| Ok(Value::Bool(!scalar_equal(&a[0], &a[1])))),
    );
    r.insert(
        "jsonEq".into(),
        FnEntry::pure(2, |a| Ok(Value::Bool(json_equal(&a[0], &a[1])))),
    );
    r.insert(
        "jsonNeq".into(),
        FnEntry::pure(2, |a| Ok(Value::Bool(!json_equal(&a[0], &a[1])))),
    );
    r.insert(
        "gt".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "gt")?;
            Ok(Value::Bool(x > y))
        }),
    );
    r.insert(
        "gte".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "gte")?;
            Ok(Value::Bool(x >= y))
        }),
    );
    r.insert(
        "lt".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "lt")?;
            Ok(Value::Bool(x < y))
        }),
    );
    r.insert(
        "lte".into(),
        FnEntry::pure(2, |a| {
            let (x, y) = two_floats(a, "lte")?;
            Ok(Value::Bool(x <= y))
        }),
    );

    // -- Logic --------------------------------------------------------------
    r.insert(
        "not".into(),
        FnEntry::pure(1, |a| {
            let b = a[0]
                .as_bool()
                .ok_or_else(|| EvalError("not: argument must be a boolean".into()))?;
            Ok(Value::Bool(!b))
        }),
    );
    r.insert(
        "and".into(),
        FnEntry::pure(2, |a| {
            let (Some(x), Some(y)) = (a[0].as_bool(), a[1].as_bool()) else {
                return Err(EvalError("and: arguments must be booleans".into()));
            };
            Ok(Value::Bool(x && y))
        }),
    );
    r.insert(
        "or".into(),
        FnEntry::pure(2, |a| {
            let (Some(x), Some(y)) = (a[0].as_bool(), a[1].as_bool()) else {
                return Err(EvalError("or: arguments must be booleans".into()));
            };
            Ok(Value::Bool(x || y))
        }),
    );

    // -- Type predicates ---------------------------------------------------
    r.insert(
        "isNull".into(),
        FnEntry::pure(1, |a| Ok(Value::Bool(a[0].is_null()))),
    );
    r.insert(
        "isBool".into(),
        FnEntry::pure(1, |a| Ok(Value::Bool(a[0].is_boolean()))),
    );
    r.insert(
        "isNumber".into(),
        FnEntry::pure(1, |a| Ok(Value::Bool(a[0].is_number()))),
    );
    r.insert(
        "isString".into(),
        FnEntry::pure(1, |a| Ok(Value::Bool(a[0].is_string()))),
    );
    r.insert(
        "isArray".into(),
        FnEntry::pure(1, |a| Ok(Value::Bool(a[0].is_array()))),
    );
    r.insert(
        "isObject".into(),
        FnEntry::pure(1, |a| Ok(Value::Bool(a[0].is_object()))),
    );

    // -- Coercion ----------------------------------------------------------
    r.insert(
        "str".into(),
        FnEntry::pure(1, |a| {
            if let Value::String(s) = &a[0] {
                return Ok(Value::String(s.clone()));
            }
            let s = serde_json::to_string(&a[0]).unwrap_or_default();
            Ok(Value::String(s))
        }),
    );
    r.insert(
        "num".into(),
        FnEntry::pure(1, |a| match &a[0] {
            Value::Number(n) => Ok(Value::Number(n.clone())),
            Value::Bool(true) => Ok(num(1.0)),
            Value::Bool(false) => Ok(num(0.0)),
            Value::Null => Ok(num(0.0)),
            Value::String(s) => match s.parse::<f64>() {
                Ok(n) => Ok(num(n)),
                Err(_) => Err(EvalError(format!("num: cannot parse {s:?} as number"))),
            },
            other => Err(EvalError(format!(
                "num: cannot convert {} to number",
                crate::value::type_name(other)
            ))),
        }),
    );

    // -- Arrays & strings --------------------------------------------------
    r.insert(
        "length".into(),
        FnEntry::pure(1, |a| match &a[0] {
            Value::Array(arr) => Ok(num(arr.len() as f64)),
            Value::String(s) => Ok(num(s.len() as f64)),
            _ => Err(EvalError(
                "length: argument must be an array or string".into(),
            )),
        }),
    );
    r.insert(
        "head".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("head: argument must be an array".into()))?;
            Ok(arr.first().cloned().unwrap_or(Value::Null))
        }),
    );
    r.insert(
        "last".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("last: argument must be an array".into()))?;
            Ok(arr.last().cloned().unwrap_or(Value::Null))
        }),
    );
    r.insert(
        "tail".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("tail: argument must be an array".into()))?;
            if arr.is_empty() {
                return Ok(Value::Array(Vec::new()));
            }
            Ok(Value::Array(arr[1..].to_vec()))
        }),
    );
    r.insert(
        "concat".into(),
        FnEntry::pure(-1, |a| {
            let mut out = Vec::new();
            for v in a {
                let arr = v
                    .as_array()
                    .ok_or_else(|| EvalError("concat: all arguments must be arrays".into()))?;
                out.extend_from_slice(arr);
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "range".into(),
        FnEntry::pure(1, |a| {
            let n = to_f64(&a[0])
                .ok_or_else(|| EvalError("range: argument must be a number".into()))?;
            let len = n as i64;
            let mut out = Vec::with_capacity(len.max(0) as usize);
            for i in 0..len {
                out.push(num(i as f64));
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "slice".into(),
        FnEntry::pure(-1, |a| {
            let start_f =
                to_f64(&a[1]).ok_or_else(|| EvalError("slice: start must be a number".into()))?;
            let mut s = start_f as i64;
            match &a[0] {
                Value::Array(arr) => {
                    let len = arr.len() as i64;
                    if s < 0 {
                        s += len;
                    }
                    if s < 0 {
                        s = 0;
                    }
                    let end_idx: Option<i64> = if a.len() > 2 && !a[2].is_null() {
                        let e = to_f64(&a[2])
                            .ok_or_else(|| EvalError("slice: end must be a number".into()))?;
                        let mut e = e as i64;
                        if e < 0 {
                            e += len;
                        }
                        if e > len {
                            e = len;
                        }
                        Some(e)
                    } else {
                        None
                    };
                    let end = end_idx.unwrap_or(len);
                    if s > end {
                        return Ok(Value::Array(Vec::new()));
                    }
                    if (s as usize) >= arr.len() {
                        return Ok(Value::Array(Vec::new()));
                    }
                    Ok(Value::Array(arr[s as usize..end as usize].to_vec()))
                }
                Value::String(string) => {
                    let len = string.len() as i64;
                    if s < 0 {
                        s += len;
                    }
                    if s < 0 {
                        s = 0;
                    }
                    let end_idx: Option<i64> = if a.len() > 2 && !a[2].is_null() {
                        let e = to_f64(&a[2])
                            .ok_or_else(|| EvalError("slice: end must be a number".into()))?;
                        let mut e = e as i64;
                        if e < 0 {
                            e += len;
                        }
                        if e > len {
                            e = len;
                        }
                        Some(e)
                    } else {
                        None
                    };
                    let end = end_idx.unwrap_or(len);
                    if s > end {
                        return Ok(Value::String(String::new()));
                    }
                    if (s as usize) >= string.len() {
                        return Ok(Value::String(String::new()));
                    }
                    Ok(Value::String(string[s as usize..end as usize].to_string()))
                }
                _ => Err(EvalError(
                    "slice: first argument must be an array or string".into(),
                )),
            }
        }),
    );
    r.insert(
        "reverse".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("reverse: argument must be an array".into()))?;
            let mut out = arr.clone();
            out.reverse();
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "includes".into(),
        FnEntry::pure(2, |a| match &a[0] {
            Value::Array(arr) => Ok(Value::Bool(arr.iter().any(|x| scalar_equal(x, &a[1])))),
            Value::String(s) => match a[1].as_str() {
                Some(sub) => Ok(Value::Bool(s.contains(sub))),
                None => Ok(Value::Bool(false)),
            },
            _ => Err(EvalError(
                "includes: first argument must be an array or string".into(),
            )),
        }),
    );
    r.insert(
        "indexOf".into(),
        FnEntry::pure(2, |a| match &a[0] {
            Value::Array(arr) => {
                for (i, v) in arr.iter().enumerate() {
                    if scalar_equal(v, &a[1]) {
                        return Ok(num(i as f64));
                    }
                }
                Ok(num(-1.0))
            }
            Value::String(s) => match a[1].as_str() {
                Some(sub) => match s.find(sub) {
                    Some(i) => Ok(num(i as f64)),
                    None => Ok(num(-1.0)),
                },
                None => Ok(num(-1.0)),
            },
            _ => Err(EvalError(
                "indexOf: first argument must be an array or string".into(),
            )),
        }),
    );
    r.insert(
        "flatten".into(),
        FnEntry::pure(1, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("flatten: argument must be an array".into()))?;
            let mut out = Vec::new();
            for item in arr {
                if let Value::Array(inner) = item {
                    out.extend_from_slice(inner);
                } else {
                    out.push(item.clone());
                }
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "setAt".into(),
        FnEntry::pure(3, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("setAt: first argument must be an array".into()))?;
            let idx_f = to_f64(&a[1])
                .ok_or_else(|| EvalError("setAt: second argument must be a number".into()))?;
            let idx = idx_f as i64;
            if idx < 0 || (idx as usize) >= arr.len() {
                return Err(EvalError(format!(
                    "setAt: index {idx} out of bounds for array of length {}",
                    arr.len()
                )));
            }
            let mut out = arr.clone();
            out[idx as usize] = a[2].clone();
            Ok(Value::Array(out))
        }),
    );

    // -- Strings -----------------------------------------------------------
    r.insert(
        "upper".into(),
        FnEntry::pure(1, |a| {
            let s = a[0]
                .as_str()
                .ok_or_else(|| EvalError("upper: argument must be a string".into()))?;
            Ok(Value::String(s.to_uppercase()))
        }),
    );
    r.insert(
        "lower".into(),
        FnEntry::pure(1, |a| {
            let s = a[0]
                .as_str()
                .ok_or_else(|| EvalError("lower: argument must be a string".into()))?;
            Ok(Value::String(s.to_lowercase()))
        }),
    );
    r.insert(
        "trim".into(),
        FnEntry::pure(1, |a| {
            let s = a[0]
                .as_str()
                .ok_or_else(|| EvalError("trim: argument must be a string".into()))?;
            Ok(Value::String(s.trim().to_string()))
        }),
    );
    r.insert(
        "strcat".into(),
        FnEntry::pure(2, |a| {
            let (Some(x), Some(y)) = (a[0].as_str(), a[1].as_str()) else {
                return Err(EvalError("strcat: arguments must be strings".into()));
            };
            Ok(Value::String(format!("{x}{y}")))
        }),
    );
    r.insert(
        "split".into(),
        FnEntry::pure(2, |a| {
            let (Some(s), Some(sep)) = (a[0].as_str(), a[1].as_str()) else {
                return Err(EvalError("split: arguments must be strings".into()));
            };
            let parts: Vec<Value> = if sep.is_empty() {
                s.chars().map(|c| Value::String(c.to_string())).collect()
            } else {
                s.split(sep).map(|p| Value::String(p.to_string())).collect()
            };
            Ok(Value::Array(parts))
        }),
    );
    r.insert(
        "join".into(),
        FnEntry::pure(2, |a| {
            let arr = a[0]
                .as_array()
                .ok_or_else(|| EvalError("join: first argument must be an array".into()))?;
            let sep = a[1]
                .as_str()
                .ok_or_else(|| EvalError("join: second argument must be a string".into()))?;
            let parts: Vec<String> = arr
                .iter()
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                })
                .collect();
            Ok(Value::String(parts.join(sep)))
        }),
    );

    // -- Object utilities --------------------------------------------------
    r.insert(
        "keys".into(),
        FnEntry::pure(1, |a| {
            let obj = a[0]
                .as_object()
                .ok_or_else(|| EvalError("keys: argument must be an object".into()))?;
            let out: Vec<Value> = sorted_keys(obj)
                .into_iter()
                .map(|k| Value::String(k.clone()))
                .collect();
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "values".into(),
        FnEntry::pure(1, |a| {
            let obj = a[0]
                .as_object()
                .ok_or_else(|| EvalError("values: argument must be an object".into()))?;
            let out: Vec<Value> = sorted_keys(obj)
                .into_iter()
                .map(|k| obj[k].clone())
                .collect();
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "entries".into(),
        FnEntry::pure(1, |a| {
            let obj = a[0]
                .as_object()
                .ok_or_else(|| EvalError("entries: argument must be an object".into()))?;
            let out: Vec<Value> = sorted_keys(obj)
                .into_iter()
                .map(|k| Value::Array(vec![Value::String(k.clone()), obj[k].clone()]))
                .collect();
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "fromEntries".into(),
        FnEntry::pure(1, |a| {
            let pairs = a[0]
                .as_array()
                .ok_or_else(|| EvalError("fromEntries: argument must be an array".into()))?;
            let mut out = Map::new();
            for p in pairs {
                let pair = p.as_array().ok_or_else(|| {
                    EvalError("fromEntries: each entry must be a [key, value] pair".into())
                })?;
                if pair.len() < 2 {
                    return Err(EvalError(
                        "fromEntries: each entry must be a [key, value] pair".into(),
                    ));
                }
                let key = pair[0]
                    .as_str()
                    .ok_or_else(|| EvalError("fromEntries: keys must be strings".into()))?;
                out.insert(key.to_string(), pair[1].clone());
            }
            Ok(Value::Object(out))
        }),
    );
    r.insert(
        "merge".into(),
        FnEntry::pure(2, |a| {
            let (Some(x), Some(y)) = (a[0].as_object(), a[1].as_object()) else {
                return Err(EvalError("merge: arguments must be objects".into()));
            };
            let mut out = x.clone();
            for (k, v) in y {
                out.insert(k.clone(), v.clone());
            }
            Ok(Value::Object(out))
        }),
    );
    r.insert(
        "hasKey".into(),
        FnEntry::pure(2, |a| {
            let obj = a[0]
                .as_object()
                .ok_or_else(|| EvalError("hasKey: first argument must be an object".into()))?;
            let key = a[1]
                .as_str()
                .ok_or_else(|| EvalError("hasKey: second argument must be a string".into()))?;
            Ok(Value::Bool(obj.contains_key(key)))
        }),
    );
    r.insert(
        "pick".into(),
        FnEntry::pure(2, |a| {
            let obj = a[0]
                .as_object()
                .ok_or_else(|| EvalError("pick: first argument must be an object".into()))?;
            let ks = a[1]
                .as_array()
                .ok_or_else(|| EvalError("pick: second argument must be an array".into()))?;
            let mut out = Map::new();
            for k in ks {
                if let Some(s) = k.as_str()
                    && let Some(v) = obj.get(s)
                {
                    out.insert(s.to_string(), v.clone());
                }
            }
            Ok(Value::Object(out))
        }),
    );
    r.insert(
        "omit".into(),
        FnEntry::pure(2, |a| {
            let obj = a[0]
                .as_object()
                .ok_or_else(|| EvalError("omit: first argument must be an object".into()))?;
            let ks = a[1]
                .as_array()
                .ok_or_else(|| EvalError("omit: second argument must be an array".into()))?;
            let exclude: std::collections::HashSet<&str> =
                ks.iter().filter_map(|v| v.as_str()).collect();
            let mut out = Map::new();
            for (k, v) in obj {
                if !exclude.contains(k.as_str()) {
                    out.insert(k.clone(), v.clone());
                }
            }
            Ok(Value::Object(out))
        }),
    );

    // -- Higher-order ------------------------------------------------------
    r.insert(
        "map".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("map: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                out.push(ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?);
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "filter".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("filter: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut out = Vec::new();
            for (i, item) in arr.iter().enumerate() {
                let v = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                if is_truthy(&v) {
                    out.push(item.clone());
                }
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "reduce".into(),
        FnEntry::builtin(3, |a, ctx| {
            let arr = a[2]
                .as_array()
                .ok_or_else(|| EvalError("reduce: third argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut acc = a[1].clone();
            for (i, item) in arr.iter().enumerate() {
                acc = ctx.call_prepared(&f, &[acc, item.clone(), num(i as f64)])?;
            }
            Ok(acc)
        }),
    );
    r.insert(
        "find".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("find: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            for (i, item) in arr.iter().enumerate() {
                let v = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                if is_truthy(&v) {
                    return Ok(item.clone());
                }
            }
            Ok(Value::Null)
        }),
    );
    r.insert(
        "findIndex".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("findIndex: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            for (i, item) in arr.iter().enumerate() {
                let v = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                if is_truthy(&v) {
                    return Ok(num(i as f64));
                }
            }
            Ok(num(-1.0))
        }),
    );
    r.insert(
        "some".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("some: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            for (i, item) in arr.iter().enumerate() {
                let v = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                if is_truthy(&v) {
                    return Ok(Value::Bool(true));
                }
            }
            Ok(Value::Bool(false))
        }),
    );
    r.insert(
        "every".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("every: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            for (i, item) in arr.iter().enumerate() {
                let v = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                if !is_truthy(&v) {
                    return Ok(Value::Bool(false));
                }
            }
            Ok(Value::Bool(true))
        }),
    );
    r.insert(
        "sort".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("sort: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            // Decorate each item with its original index so the comparator can be
            // invoked through `ctx.call` outside any cmp closure (which forbids
            // returning errors).
            let n = arr.len();
            let mut indices: Vec<usize> = (0..n).collect();
            // Insertion sort to make the comparator-error path simple.
            for i in 1..n {
                let mut j = i;
                while j > 0 {
                    let v = ctx.call_prepared(
                        &f,
                        &[arr[indices[j]].clone(), arr[indices[j - 1]].clone()],
                    )?;
                    let cmp = to_f64(&v).unwrap_or(0.0);
                    if cmp < 0.0 {
                        indices.swap(j, j - 1);
                        j -= 1;
                    } else {
                        break;
                    }
                }
            }
            let out: Vec<Value> = indices.into_iter().map(|i| arr[i].clone()).collect();
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "mapValues".into(),
        FnEntry::builtin(2, |a, ctx| {
            let obj = a[1]
                .as_object()
                .ok_or_else(|| EvalError("mapValues: second argument must be an object".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut out = Map::new();
            for (k, v) in &obj {
                let nv = ctx.call_prepared(&f, &[v.clone(), Value::String(k.clone())])?;
                out.insert(k.clone(), nv);
            }
            Ok(Value::Object(out))
        }),
    );
    r.insert(
        "flatMap".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("flatMap: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut out = Vec::new();
            for (i, item) in arr.iter().enumerate() {
                let v = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                match v {
                    Value::Array(inner) => out.extend(inner),
                    other => out.push(other),
                }
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "groupBy".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("groupBy: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut groups: Map<String, Value> = Map::new();
            for (i, item) in arr.iter().enumerate() {
                let key = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                let k = match &key {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => {
                        // Match Go's strconv.FormatFloat(_, 'f', -1, 64).
                        if let Some(f) = n.as_f64() {
                            format_go_float(f)
                        } else {
                            n.to_string()
                        }
                    }
                    other => {
                        return Err(EvalError(format!(
                            "groupBy: key function must return a string or number, got {}",
                            crate::value::type_name(other)
                        )));
                    }
                };
                match groups.get_mut(&k) {
                    Some(Value::Array(existing)) => existing.push(item.clone()),
                    _ => {
                        groups.insert(k, Value::Array(vec![item.clone()]));
                    }
                }
            }
            Ok(Value::Object(groups))
        }),
    );
    r.insert(
        "sortBy".into(),
        FnEntry::builtin(2, |a, ctx| {
            let arr = a[1]
                .as_array()
                .ok_or_else(|| EvalError("sortBy: second argument must be an array".into()))?
                .clone();
            let f = ctx.prepare(&a[0])?;
            let mut decorated: Vec<(Value, Value)> = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                let key = ctx.call_prepared(&f, &[item.clone(), num(i as f64)])?;
                decorated.push((item.clone(), key));
            }
            // Stable sort using json_less.
            decorated.sort_by(|a, b| {
                if json_less(&a.1, &b.1) {
                    std::cmp::Ordering::Less
                } else if json_less(&b.1, &a.1) {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            });
            Ok(Value::Array(
                decorated.into_iter().map(|(v, _)| v).collect(),
            ))
        }),
    );
    r.insert(
        "apply".into(),
        FnEntry::builtin(2, |a, ctx| {
            let args = a[1]
                .as_array()
                .ok_or_else(|| EvalError("apply: second argument must be an array".into()))?
                .clone();
            ctx.call(&a[0], &args)
        }),
    );
    r.insert(
        "pipe".into(),
        FnEntry::builtin(2, |a, ctx| {
            let fns = a[0]
                .as_array()
                .ok_or_else(|| {
                    EvalError("pipe: first argument must be an array of functions".into())
                })?
                .clone();
            let prepared: Vec<_> = fns
                .iter()
                .map(|f| ctx.prepare(f))
                .collect::<Result<_, _>>()?;
            let mut value = a[1].clone();
            for f in &prepared {
                value = ctx.call_prepared(f, &[value])?;
            }
            Ok(value)
        }),
    );

    // -- Regex --------------------------------------------------------------
    r.insert(
        "reTest".into(),
        FnEntry::pure(2, |a| {
            let (Some(p), Some(s)) = (a[0].as_str(), a[1].as_str()) else {
                return Err(EvalError("reTest: arguments must be strings".into()));
            };
            let re = parse_pattern(p)?;
            Ok(Value::Bool(re.is_match(s)))
        }),
    );
    r.insert(
        "reMatch".into(),
        FnEntry::pure(2, |a| {
            let (Some(p), Some(s)) = (a[0].as_str(), a[1].as_str()) else {
                return Err(EvalError("reMatch: arguments must be strings".into()));
            };
            let re = parse_pattern(p)?;
            match re.captures(s) {
                None => Ok(Value::Null),
                Some(caps) => Ok(build_match_result(&re, &caps)),
            }
        }),
    );
    r.insert(
        "reMatchAll".into(),
        FnEntry::pure(2, |a| {
            let (Some(p), Some(s)) = (a[0].as_str(), a[1].as_str()) else {
                return Err(EvalError("reMatchAll: arguments must be strings".into()));
            };
            let re = parse_pattern(p)?;
            let mut out = Vec::new();
            for caps in re.captures_iter(s) {
                out.push(build_match_result(&re, &caps));
            }
            Ok(Value::Array(out))
        }),
    );
    r.insert(
        "reReplace".into(),
        FnEntry::pure(3, |a| {
            let (Some(p), Some(rep), Some(s)) = (a[0].as_str(), a[1].as_str(), a[2].as_str())
            else {
                return Err(EvalError("reReplace: arguments must be strings".into()));
            };
            let re = parse_pattern(p)?;
            // Translate Go-style $N back-references to the regex crate's syntax (same).
            Ok(Value::String(re.replace_all(s, rep).into_owned()))
        }),
    );
    r.insert(
        "reSplit".into(),
        FnEntry::pure(2, |a| {
            let (Some(p), Some(s)) = (a[0].as_str(), a[1].as_str()) else {
                return Err(EvalError("reSplit: arguments must be strings".into()));
            };
            let re = parse_pattern(p)?;
            let parts: Vec<Value> = re.split(s).map(|p| Value::String(p.to_string())).collect();
            Ok(Value::Array(parts))
        }),
    );
    r.insert(
        "reReplaceWith".into(),
        FnEntry::builtin(3, |a, ctx| {
            let p = a[0].as_str().ok_or_else(|| {
                EvalError("reReplaceWith: first argument must be a pattern string".into())
            })?;
            let s = a[2].as_str().ok_or_else(|| {
                EvalError("reReplaceWith: third argument must be a string".into())
            })?;
            let callback = a[1].clone();
            let re = parse_pattern(p)?;
            let mut out = String::with_capacity(s.len());
            let mut last = 0;
            for caps in re.captures_iter(s) {
                let m0 = caps.get(0).unwrap();
                out.push_str(&s[last..m0.start()]);
                let match_obj = build_match_result(&re, &caps);
                let replaced = ctx.call(&callback, &[match_obj])?;
                match &replaced {
                    Value::String(rs) => out.push_str(rs),
                    other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
                }
                last = m0.end();
            }
            out.push_str(&s[last..]);
            Ok(Value::String(out))
        }),
    );

    // -- Introspection -----------------------------------------------------
    r.insert(
        "arity".into(),
        FnEntry::builtin(1, |a, ctx| {
            let registry = ctx.functions();
            match get_arity(&a[0], &registry) {
                Some(n) => Ok(num(n as f64)),
                None => Ok(Value::Null),
            }
        }),
    );

    // -- Debugging ----------------------------------------------------------
    r.insert(
        "log".into(),
        FnEntry::pure(2, {
            let logger = options.logger.clone();
            move |a| {
                if let Some(logger) = &logger {
                    logger(&a[0], a.get(1));
                }
                Ok(a[0].clone())
            }
        }),
    );

    r
}

/// Mimics Go's `strconv.FormatFloat(f, 'f', -1, 64)`: shortest decimal
/// representation without exponent, with no trailing zeros.
fn format_go_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f.is_sign_positive() {
            "+Inf".into()
        } else {
            "-Inf".into()
        };
    }
    if f == f.trunc() && f.abs() < 1e16 {
        return format!("{}", f as i64);
    }
    let s = format!("{f}");
    s
}

fn parse_pattern(pattern: &str) -> Result<Regex, EvalError> {
    static FLAGS_RE: OnceLock<Regex> = OnceLock::new();
    let flags_re = FLAGS_RE.get_or_init(|| Regex::new(r"^\(\?([imsu]*)\)").unwrap());

    let (flags, source) = if let Some(m) = flags_re.captures(pattern) {
        let f = m.get(1).map(|x| x.as_str()).unwrap_or("");
        (f.to_string(), &pattern[m.get(0).unwrap().end()..])
    } else {
        (String::new(), pattern)
    };

    let mut rust_flags = String::new();
    for f in flags.chars() {
        match f {
            'i' => rust_flags.push('i'),
            'm' => rust_flags.push('m'),
            's' => rust_flags.push('s'),
            'u' => {} // regex crate is always Unicode-aware; same as Go.
            other => return Err(EvalError(format!("reTest: unsupported flag {other:?}"))),
        }
    }

    let final_pattern = if rust_flags.is_empty() {
        source.to_string()
    } else {
        format!("(?{rust_flags}){source}")
    };

    Regex::new(&final_pattern).map_err(|e| EvalError(format!("regex compile error: {e}")))
}

fn build_match_result(re: &Regex, caps: &Captures<'_>) -> Value {
    let m0 = caps.get(0).unwrap();

    let mut groups = Vec::with_capacity(caps.len().saturating_sub(1));
    for i in 1..caps.len() {
        match caps.get(i) {
            Some(m) => groups.push(Value::String(m.as_str().to_string())),
            None => groups.push(Value::Null),
        }
    }

    let mut named = Map::new();
    for name in re.capture_names().flatten() {
        match caps.name(name) {
            Some(m) => named.insert(name.to_string(), Value::String(m.as_str().to_string())),
            None => named.insert(name.to_string(), Value::Null),
        };
    }

    let mut obj = Map::new();
    obj.insert("match".into(), Value::String(m0.as_str().to_string()));
    obj.insert("index".into(), num(m0.start() as f64));
    obj.insert("groups".into(), Value::Array(groups));
    obj.insert("named".into(), Value::Object(named));
    Value::Object(obj)
}
