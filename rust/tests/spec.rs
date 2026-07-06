//! Conformance tests. Walks `../spec/cases/*.json` and runs every test case
//! against the Rust interpreter, mirroring `go/spec_test.go`.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use jsonfn::{
    ExecutionLimits, ExecutionUsage, FnEntry, FunctionRegistry, call_function, create_stdlib,
    json_equal,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct TestCase {
    description: String,
    body: Value,
    #[serde(default)]
    args: Option<Vec<Value>>,
    #[serde(default)]
    functions: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    limits: Option<LimitsSpec>,
    #[serde(default)]
    expected: Option<Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "expectedFuel")]
    expected_fuel: Option<usize>,
}

#[derive(Deserialize, Default)]
struct LimitsSpec {
    #[serde(default, rename = "maxCallDepth")]
    max_call_depth: Option<usize>,
    #[serde(default, rename = "maxFuel")]
    max_fuel: Option<usize>,
    #[serde(default, rename = "maxValueSize")]
    max_value_size: Option<usize>,
}

#[derive(Deserialize)]
struct TestSuite {
    description: String,
    #[serde(default)]
    functions: Option<serde_json::Map<String, Value>>,
    cases: Vec<TestCase>,
}

fn spec_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("spec")
        .join("cases")
}

#[test]
fn spec_conformance() {
    let dir = spec_dir();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("Failed to read spec dir {dir:?}: {e}"))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| e.path())
        .collect();
    entries.sort();

    let mut failures: Vec<String> = Vec::new();
    let mut total = 0usize;

    for path in entries {
        let data = fs::read(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        let suite: TestSuite =
            serde_json::from_slice(&data).unwrap_or_else(|e| panic!("parse {path:?}: {e}"));

        for case in suite.cases {
            total += 1;
            if let Err(msg) = run_case(&suite.description, &suite.functions, &case) {
                failures.push(format!(
                    "{file}::{suite}::{case}\n    {msg}",
                    file = path.file_name().unwrap().to_string_lossy(),
                    suite = suite.description,
                    case = case.description,
                ));
            }
        }
    }

    if !failures.is_empty() {
        let count = failures.len();
        let summary = failures.join("\n\n");
        panic!("{count}/{total} spec cases failed:\n\n{summary}");
    }
    eprintln!("All {total} spec cases passed.");
}

fn run_case(
    _suite_desc: &str,
    suite_functions: &Option<serde_json::Map<String, Value>>,
    case: &TestCase,
) -> Result<(), String> {
    let mut registry: FunctionRegistry = create_stdlib();
    if let Some(map) = suite_functions {
        for (k, v) in map {
            registry.insert(k.clone(), FnEntry::body(v.clone()));
        }
    }
    if let Some(map) = &case.functions {
        for (k, v) in map {
            registry.insert(k.clone(), FnEntry::body(v.clone()));
        }
    }

    let args: Vec<Value> = case.args.clone().unwrap_or_default();

    // Attach a usage sink when the case asserts an exact fuel count.
    let usage = case
        .expected_fuel
        .map(|_| Arc::new(ExecutionUsage::default()));

    let limits = if case.limits.is_some() || usage.is_some() {
        let l = case.limits.as_ref();
        Some(ExecutionLimits {
            max_call_depth: l.and_then(|l| l.max_call_depth),
            max_fuel: l.and_then(|l| l.max_fuel),
            max_value_size: l.and_then(|l| l.max_value_size),
            cancel: None,
            timeout: None,
            usage: usage.clone(),
        })
    } else {
        None
    };

    let result = call_function(&case.body, &args, &registry, limits.as_ref());

    match (&case.error, result) {
        (Some(expected_msg), Err(e)) => {
            let actual = e.to_string();
            if actual.contains(expected_msg) {
                Ok(())
            } else {
                Err(format!(
                    "Expected error containing {expected_msg:?}, got: {actual:?}"
                ))
            }
        }
        (Some(expected_msg), Ok(v)) => Err(format!(
            "Expected error containing {expected_msg:?}, but got result: {v}"
        )),
        (None, Err(e)) => Err(format!("Unexpected error: {e}")),
        (None, Ok(v)) => {
            let expected = case.expected.clone().unwrap_or(Value::Null);
            if !json_equal(&v, &expected) {
                let got = serde_json::to_string_pretty(&v).unwrap_or_default();
                let want = serde_json::to_string_pretty(&expected).unwrap_or_default();
                return Err(format!(
                    "Result mismatch.\n      Got:      {got}\n      Expected: {want}"
                ));
            }
            if let (Some(expected_fuel), Some(usage)) = (case.expected_fuel, &usage) {
                let actual = usage.fuel();
                if actual != expected_fuel {
                    return Err(format!(
                        "Fuel mismatch: expected {expected_fuel}, got {actual}"
                    ));
                }
            }
            Ok(())
        }
    }
}
