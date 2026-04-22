use jsonfn::{call_function, create_stdlib};
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
