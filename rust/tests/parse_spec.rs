//! Shorthand parser conformance tests. Walks `../spec/parse-cases/*.json` and
//! runs every case against the `.jfn` shorthand parser, mirroring the evaluator
//! conformance runner in `spec.rs`. Each case parses a shorthand `source`
//! string and asserts it lowers to the canonical JSON in `expected`, or that
//! parsing fails when `error` is present.

use std::fs;
use std::path::PathBuf;

use jsonfn::{json_equal, parse_shorthand};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct TestCase {
    description: String,
    source: String,
    #[serde(default)]
    expected: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Deserialize)]
struct TestSuite {
    description: String,
    cases: Vec<TestCase>,
}

fn parse_cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("spec")
        .join("parse-cases")
}

#[test]
fn shorthand_parse_conformance() {
    let dir = parse_cases_dir();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("Failed to read parse-cases dir {dir:?}: {e}"))
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
            if let Err(msg) = run_case(&case) {
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
        panic!("{count}/{total} parse cases failed:\n\n{summary}");
    }
    eprintln!("All {total} parse cases passed.");
}

fn run_case(case: &TestCase) -> Result<(), String> {
    let result = parse_shorthand(&case.source);

    match (&case.error, result) {
        (Some(expected), Err(e)) => {
            // A string `error` asserts the message contains it; any other
            // truthy value only requires that parsing failed.
            if let Value::String(substr) = expected {
                let actual = e.to_string();
                if actual.contains(substr) {
                    Ok(())
                } else {
                    Err(format!(
                        "Expected error containing {substr:?}, got: {actual:?}"
                    ))
                }
            } else {
                Ok(())
            }
        }
        (Some(_), Ok(v)) => Err(format!("Expected a parse error, but got result: {v}")),
        (None, Err(e)) => Err(format!("Unexpected parse error: {e}")),
        (None, Ok(v)) => {
            let expected = case.expected.clone().unwrap_or(Value::Null);
            if json_equal(&v, &expected) {
                Ok(())
            } else {
                let got = serde_json::to_string_pretty(&v).unwrap_or_default();
                let want = serde_json::to_string_pretty(&expected).unwrap_or_default();
                Err(format!(
                    "Result mismatch.\n      Got:      {got}\n      Expected: {want}"
                ))
            }
        }
    }
}
