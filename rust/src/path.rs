use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::error::EvalError;

/// One segment of a parsed `$var` path: a string key or numeric index.
#[derive(Clone, Debug)]
pub enum Segment {
    Key(String),
    Index(i64),
}

#[derive(Clone, Debug)]
pub struct ParsedPath {
    pub variable: String,
    pub path: Vec<Segment>,
}

const PATH_CACHE_MAX: usize = 1024;

fn cache() -> &'static Mutex<HashMap<String, ParsedPath>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ParsedPath>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parses paths like `foo`, `foo.bar`, `items[0]`, `data.items[1].name`.
/// `.key` is a string segment, `[N]` is a numeric index when the inner text
/// is a valid integer (otherwise it's treated as a string key). Mirrors
/// Go's `parsePath`.
pub fn parse_path(s: &str) -> Result<ParsedPath, EvalError> {
    {
        let guard = cache().lock().unwrap();
        if let Some(p) = guard.get(s) {
            return Ok(p.clone());
        }
    }

    let bytes = s.as_bytes();
    let dot = bytes.iter().position(|&b| b == b'.');
    let bracket = bytes.iter().position(|&b| b == b'[');

    if dot.is_none() && bracket.is_none() {
        let parsed = ParsedPath {
            variable: s.to_string(),
            path: Vec::new(),
        };
        cache_put(s, parsed.clone());
        return Ok(parsed);
    }

    let split = match (dot, bracket) {
        (None, Some(b)) => b,
        (Some(d), None) => d,
        (Some(d), Some(b)) => d.min(b),
        (None, None) => unreachable!(),
    };

    let variable = &s[..split];
    if variable.is_empty() {
        return Err(EvalError(format!(
            r#"Invalid $var path: variable name cannot be empty in "{s}""#
        )));
    }

    let mut path = Vec::new();
    let mut i = split;
    while i < bytes.len() {
        match bytes[i] {
            b'.' => {
                i += 1;
                let start = i;
                while i < bytes.len() && bytes[i] != b'.' && bytes[i] != b'[' {
                    i += 1;
                }
                if i == start {
                    return Err(EvalError(format!(
                        r#"Invalid $var path: empty segment after "." in "{s}""#
                    )));
                }
                path.push(Segment::Key(s[start..i].to_string()));
            }
            b'[' => {
                i += 1;
                let close = match s[i..].find(']') {
                    Some(c) => i + c,
                    None => {
                        return Err(EvalError(format!(
                            r#"Invalid $var path: unclosed "[" in "{s}""#
                        )));
                    }
                };
                let inner = &s[i..close];
                if inner.is_empty() {
                    return Err(EvalError(format!(
                        r#"Invalid $var path: empty "[]" in "{s}""#
                    )));
                }
                if let Ok(n) = inner.parse::<i64>()
                    && n.to_string() == inner
                {
                    path.push(Segment::Index(n));
                } else {
                    path.push(Segment::Key(inner.to_string()));
                }
                i = close + 1;
            }
            ch => {
                return Err(EvalError(format!(
                    r#"Invalid $var path: unexpected character "{}" in "{s}""#,
                    ch as char
                )));
            }
        }
    }

    let parsed = ParsedPath {
        variable: variable.to_string(),
        path,
    };
    cache_put(s, parsed.clone());
    Ok(parsed)
}

fn cache_put(key: &str, value: ParsedPath) {
    let mut guard = cache().lock().unwrap();
    if guard.len() >= PATH_CACHE_MAX {
        if let Some(any_key) = guard.keys().next().cloned() {
            guard.remove(&any_key);
        }
    }
    guard.insert(key.to_string(), value);
}

/// Walks a parsed path, returning `Value::Null` for any out-of-bounds or
/// type-mismatch step. Mirrors Go's `walkPath`.
pub fn walk_path(value: &Value, path: &[Segment]) -> Value {
    let mut current = value;
    for seg in path {
        match (current, seg) {
            (Value::String(s), Segment::Index(i)) => {
                let bytes = s.as_bytes();
                if *i >= 0 && (*i as usize) < bytes.len() {
                    return Value::String((bytes[*i as usize] as char).to_string());
                }
                return Value::Null;
            }
            (Value::Object(map), Segment::Key(k)) => match map.get(k) {
                Some(v) => current = v,
                None => return Value::Null,
            },
            (Value::Array(arr), Segment::Index(i)) => {
                if *i >= 0 && (*i as usize) < arr.len() {
                    current = &arr[*i as usize];
                } else {
                    return Value::Null;
                }
            }
            _ => return Value::Null,
        }
    }
    current.clone()
}

pub fn validate_param_name(name: &str) -> Result<(), EvalError> {
    if name.contains('.') || name.contains('[') {
        return Err(EvalError(format!(
            r#"Parameter name "{name}" must not contain "." or "[". Use simple identifiers."#
        )));
    }
    Ok(())
}
