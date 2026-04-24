//! chess.rs — Thin host shell for the json-fn chess engine.
//!
//! All chess rules, parsing, rendering, and user-facing messaging live in
//! `examples/chess.jsonc`. This binary does only what JSON cannot: read
//! argv, load/save the state file, and print to stdout/stderr.
//!
//! Run with: `cargo run --example chess --release -- e2e4`

use std::env;
use std::fs;
use std::path::PathBuf;

use jsonfn::{
    FnEntry, FunctionRegistry, Value, call_function, create_stdlib, strip_jsonc,
};
use serde_json::Map;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let chess_path = manifest_dir.join("..").join("examples").join("chess.jsonc");
    let raw = fs::read_to_string(&chess_path).expect("read chess.jsonc");
    let cleaned = strip_jsonc(&raw);
    let game: Map<String, Value> = serde_json::from_str(&cleaned).expect("parse chess.jsonc");
    let mut fns: FunctionRegistry = create_stdlib();
    for (k, v) in game {
        fns.insert(k, FnEntry::body(v));
    }

    let state_file = manifest_dir.join("examples").join(".chess-state.json");

    let state: Value = if state_file.exists() {
        let data = fs::read_to_string(&state_file).expect("read state file");
        serde_json::from_str(&data).expect("parse state file")
    } else {
        call_function(&Value::String("newGame".into()), &[], &fns, None).expect("newGame")
    };

    let argv: Vec<Value> = env::args().skip(1).map(Value::String).collect();
    let result = call_function(
        &Value::String("handleCommand".into()),
        &[state, Value::Array(argv)],
        &fns,
        None,
    )
    .expect("handleCommand");

    let output = result.get("output").and_then(Value::as_str).unwrap_or("");
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or("");
    let new_state = result.get("newState").cloned().unwrap_or(Value::Null);
    let reset = result.get("reset").and_then(Value::as_bool).unwrap_or(false);
    let exit_code = result.get("exitCode").and_then(Value::as_i64).unwrap_or(0);

    if reset && state_file.exists() {
        let _ = fs::remove_file(&state_file);
    }
    if !new_state.is_null() {
        let serialized = serde_json::to_string(&new_state).expect("serialize state");
        fs::write(&state_file, serialized).expect("write state file");
    }

    if !output.is_empty() {
        println!("{output}");
    }
    if !stderr.is_empty() {
        eprintln!("{stderr}");
    }

    std::process::exit(exit_code as i32);
}
