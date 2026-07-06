//! Cooperative cancellation and the host-only wall-clock backstop.
//!
//! Neither the cancel flag nor the timeout is part of the conformance spec
//! (the deadline is non-deterministic); they are implementation-level safety
//! nets, so they live here rather than in the shared spec suite.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use jsonfn::{ExecutionLimits, call_function, create_stdlib};
use serde_json::{Value, json};

fn fib_registry() -> jsonfn::FunctionRegistry {
    let mut reg = create_stdlib();
    reg.insert(
        "fib".into(),
        jsonfn::FnEntry::body(json!({
            "$params": ["n"],
            "$return": {
                "$if": { "$fn": ["lte", { "$var": "n" }, 1] },
                "$then": { "$var": "n" },
                "$else": { "$fn": [
                    "add",
                    { "$fn": ["fib", { "$fn": ["sub", { "$var": "n" }, 1] }] },
                    { "$fn": ["fib", { "$fn": ["sub", { "$var": "n" }, 2] }] }
                ] }
            }
        })),
    );
    reg
}

fn limits_with(cancel: Option<Arc<AtomicBool>>, timeout: Option<Duration>) -> ExecutionLimits {
    ExecutionLimits {
        cancel,
        timeout,
        ..Default::default()
    }
}

#[test]
fn set_cancel_flag_aborts() {
    let cancel = Arc::new(AtomicBool::new(true));
    let body = json!({ "$return": { "$fn": ["fib", 30] } });
    let err = call_function(
        &body,
        &[],
        &fib_registry(),
        Some(&limits_with(Some(cancel), None)),
    )
    .expect_err("should abort");
    assert!(err.to_string().contains("Execution aborted"), "{err}");
}

#[test]
fn unset_cancel_flag_does_not_interfere() {
    let cancel = Arc::new(AtomicBool::new(false));
    let body = json!({ "$return": { "$fn": ["add", 1, 2] } });
    let result = call_function(
        &body,
        &[],
        &create_stdlib(),
        Some(&limits_with(Some(cancel), None)),
    )
    .expect("eval");
    assert_eq!(result, json!(3));
}

#[test]
fn zero_timeout_times_out() {
    let body = json!({ "$return": { "$fn": ["fib", 30] } });
    let err = call_function(
        &body,
        &[],
        &fib_registry(),
        Some(&limits_with(None, Some(Duration::ZERO))),
    )
    .expect_err("should time out");
    assert!(err.to_string().contains("Execution timed out"), "{err}");
}

#[test]
fn generous_timeout_does_not_interfere() {
    let body = json!({ "$return": { "$fn": ["add", 1, 2] } });
    let result = call_function(
        &body,
        &[],
        &create_stdlib(),
        Some(&limits_with(None, Some(Duration::from_secs(60)))),
    )
    .expect("eval");
    assert_eq!(result, json!(3));
}

// A deadline must also interrupt a native higher-order loop over a pure
// builtin — the op-bomb shape that never re-enters evaluate_expression.
#[test]
fn timeout_interrupts_higher_order_loop() {
    let body: Value = json!({
        "$return": { "$fn": ["map", "neg", { "$fn": ["range", 2_000_000] }] }
    });
    let err = call_function(
        &body,
        &[],
        &create_stdlib(),
        Some(&limits_with(None, Some(Duration::ZERO))),
    )
    .expect_err("should time out");
    assert!(err.to_string().contains("Execution timed out"), "{err}");
}
