use std::sync::{Arc, Mutex};

use jsonfn::{StdlibOptions, call_function, create_stdlib, create_stdlib_with_options};
use serde_json::json;

#[test]
fn smoke_add() {
    let stdlib = create_stdlib();
    let body = json!({
        "$params": ["a", "b"],
        "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] }
    });
    let result = call_function(&body, &[json!(2), json!(3)], &stdlib, None).expect("eval");
    assert_eq!(result, json!(5));
}

#[test]
fn smoke_higher_order() {
    let stdlib = create_stdlib();
    let body = json!({
        "$return": {
            "$fn": ["map", {
                "$params": ["x"],
                "$return": { "$fn": ["mul", { "$var": "x" }, 2] }
            }, [1, 2, 3, 4]]
        }
    });
    let result = call_function(&body, &[], &stdlib, None).expect("eval");
    assert_eq!(result, json!([2, 4, 6, 8]));
}

#[test]
fn smoke_log_returns_value() {
    let stdlib = create_stdlib();
    let body = json!({
        "$return": {
            "$fn": ["log", { "answer": 42, "ok": true }, "debug"]
        }
    });
    let result = call_function(&body, &[], &stdlib, None).expect("eval");
    assert_eq!(result, json!({ "answer": 42, "ok": true }));
}

#[test]
fn smoke_log_calls_configured_logger() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let logger_calls = Arc::clone(&calls);
    let stdlib = create_stdlib_with_options(StdlibOptions {
        logger: Some(Arc::new(move |value, label| {
            logger_calls
                .lock()
                .unwrap()
                .push((value.clone(), label.cloned()));
        })),
    });
    let body = json!({
        "$return": {
            "$fn": ["log", { "answer": 42, "ok": true }, "debug"]
        }
    });

    let result = call_function(&body, &[], &stdlib, None).expect("eval");

    assert_eq!(result, json!({ "answer": 42, "ok": true }));
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(json!({ "answer": 42, "ok": true }), Some(json!("debug")))]
    );
}
