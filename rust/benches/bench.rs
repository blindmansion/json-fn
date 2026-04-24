//! Criterion benchmarks mirroring `go/benchmark_test.go`.
//!
//! Run with: `cargo bench --bench bench`
//!
//! Each scenario builds the same json-fn program shape used by the Go and
//! TypeScript benchmark suites so cross-implementation comparisons are
//! apples-to-apples.

use std::fs;
use std::path::PathBuf;

use criterion::{Criterion, criterion_group, criterion_main};
use jsonfn::{FnEntry, FunctionRegistry, Value, call_function, create_stdlib, strip_jsonc};
use serde_json::{Map, json};

fn make_deep_add(depth: usize) -> Value {
    let mut expr = json!(0);
    for _ in 0..depth {
        expr = json!({ "$fn": ["add", expr, 1] });
    }
    json!({ "$return": expr })
}

fn bench_deep_arithmetic(c: &mut Criterion) {
    let mut group = c.benchmark_group("deep_arithmetic");
    for &depth in &[100usize, 500, 1000, 5000] {
        let program = make_deep_add(depth);
        let stdlib = create_stdlib();
        group.bench_function(format!("depth={depth}"), |b| {
            b.iter(|| call_function(std::hint::black_box(&program), &[], &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn bench_map_over_arrays(c: &mut Criterion) {
    let program = json!({
        "$params": ["arr"],
        "$return": {
            "$fn": ["map", {
                "$params": ["x"],
                "$return": { "$fn": ["add", { "$var": "x" }, 1] }
            }, { "$var": "arr" }]
        }
    });

    let mut group = c.benchmark_group("map_over_arrays");
    for &size in &[100usize, 1000, 5000, 10000] {
        let arr: Vec<Value> = (0..size).map(|i| json!(i)).collect();
        let args = vec![Value::Array(arr)];
        let stdlib = create_stdlib();
        group.bench_function(format!("size={size}"), |b| {
            b.iter(|| call_function(&program, std::hint::black_box(&args), &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn bench_nested_map(c: &mut Criterion) {
    let program = json!({
        "$params": ["grid"],
        "$return": {
            "$fn": ["map", {
                "$params": ["row"],
                "$return": {
                    "$fn": ["map", {
                        "$params": ["x"],
                        "$return": { "$fn": ["add", { "$var": "x" }, 1] }
                    }, { "$var": "row" }]
                }
            }, { "$var": "grid" }]
        }
    });

    let mut group = c.benchmark_group("nested_map");
    for &size in &[10usize, 50, 100] {
        let grid: Vec<Value> = (0..size)
            .map(|_| Value::Array((0..size).map(|j| json!(j)).collect()))
            .collect();
        let args = vec![Value::Array(grid)];
        let stdlib = create_stdlib();
        group.bench_function(format!("{size}x{size}"), |b| {
            b.iter(|| call_function(&program, std::hint::black_box(&args), &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn bench_reduce(c: &mut Criterion) {
    let program = json!({
        "$params": ["arr"],
        "$return": {
            "$fn": ["reduce", {
                "$params": ["acc", "item"],
                "$return": { "$fn": ["add", { "$var": "acc" }, { "$var": "item" }] }
            }, 0, { "$var": "arr" }]
        }
    });

    let mut group = c.benchmark_group("reduce");
    for &size in &[100usize, 1000, 5000, 10000] {
        let arr: Vec<Value> = (0..size).map(|i| json!(i)).collect();
        let args = vec![Value::Array(arr)];
        let stdlib = create_stdlib();
        group.bench_function(format!("size={size}"), |b| {
            b.iter(|| call_function(&program, std::hint::black_box(&args), &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn make_many_vars(num_vars: usize) -> Value {
    let mut body = Map::new();
    body.insert("$params".into(), json!(["v0"]));
    for i in 1..num_vars {
        body.insert(
            format!("v{i}"),
            json!({ "$fn": ["add", { "$var": format!("v{}", i - 1) }, 1] }),
        );
    }
    body.insert(
        "$return".into(),
        json!({ "$var": format!("v{}", num_vars - 1) }),
    );
    Value::Object(body)
}

fn bench_many_vars(c: &mut Criterion) {
    let mut group = c.benchmark_group("many_vars");
    for &n in &[10usize, 50, 100, 500] {
        let program = make_many_vars(n);
        let stdlib = create_stdlib();
        let args = vec![json!(0)];
        group.bench_function(format!("vars={n}"), |b| {
            b.iter(|| call_function(&program, std::hint::black_box(&args), &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn bench_fibonacci(c: &mut Criterion) {
    let mut group = c.benchmark_group("fibonacci");
    for &n in &[10i64, 15, 20] {
        let mut stdlib = create_stdlib();
        stdlib.insert(
            "fib".into(),
            FnEntry::body(json!({
                "$params": ["n"],
                "$return": {
                    "$if": { "$fn": ["lte", { "$var": "n" }, 1] },
                    "$then": { "$var": "n" },
                    "$else": {
                        "$fn": ["add",
                            { "$fn": ["fib", { "$fn": ["sub", { "$var": "n" }, 1] }] },
                            { "$fn": ["fib", { "$fn": ["sub", { "$var": "n" }, 2] }] }
                        ]
                    }
                }
            })),
        );
        let program = json!({ "$return": { "$fn": ["fib", n] } });
        group.bench_function(format!("n={n}"), |b| {
            b.iter(|| call_function(&program, &[], &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn make_closure_stress(captured_vars: usize, array_size: usize) -> Value {
    let mut body = Map::new();
    for i in 0..captured_vars {
        body.insert(format!("c{i}"), json!(i));
    }
    body.insert(
        "$return".into(),
        json!({
            "$fn": ["map", {
                "$params": ["x"],
                "$return": { "$fn": ["add", { "$var": "x" }, { "$var": "c0" }] }
            }, { "$fn": ["range", array_size] }]
        }),
    );
    Value::Object(body)
}

fn bench_closure_capture(c: &mut Criterion) {
    let mut group = c.benchmark_group("closure_capture");
    for &(vars, size) in &[
        (5usize, 1000usize),
        (50, 1000),
        (200, 1000),
        (5, 10000),
        (50, 10000),
    ] {
        let program = make_closure_stress(vars, size);
        let stdlib = create_stdlib();
        group.bench_function(format!("vars={vars}_arr={size}"), |b| {
            b.iter(|| call_function(&program, &[], &stdlib, None).unwrap())
        });
    }
    group.finish();
}

fn bench_chess_fools_mate(c: &mut Criterion) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples")
        .join("chess.jsonc");
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let cleaned = strip_jsonc(&raw);
    let game: Map<String, Value> = serde_json::from_str(&cleaned).unwrap();
    let mut fns: FunctionRegistry = create_stdlib();
    for (k, v) in game {
        fns.insert(k, FnEntry::body(v));
    }

    let initial_state = json!({
        "board": (0..64).map(initial_square).collect::<Vec<_>>(),
        "turn": "w",
        "status": "playing",
    });

    c.bench_function("chess_fools_mate", |b| {
        b.iter(|| {
            let mut state = initial_state.clone();
            for (from, to) in [("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4")] {
                state = call_function(
                    &Value::String("playMove".into()),
                    &[state.clone(), json!(sq(from)), json!(sq(to))],
                    &fns,
                    None,
                )
                .unwrap();
            }
            state
        })
    });
}

fn sq(s: &str) -> i64 {
    let b = s.as_bytes();
    (b[1] - b'1') as i64 * 8 + (b[0] - b'a') as i64
}

fn initial_square(i: i64) -> Value {
    let row = i / 8;
    let col = i % 8;
    let p = match (row, col) {
        (0, 0 | 7) => "R",
        (0, 1 | 6) => "N",
        (0, 2 | 5) => "B",
        (0, 3) => "Q",
        (0, 4) => "K",
        (1, _) => "P",
        (6, _) => "p",
        (7, 0 | 7) => "r",
        (7, 1 | 6) => "n",
        (7, 2 | 5) => "b",
        (7, 3) => "q",
        (7, 4) => "k",
        _ => return Value::Null,
    };
    Value::String(p.into())
}

criterion_group!(
    benches,
    bench_deep_arithmetic,
    bench_map_over_arrays,
    bench_nested_map,
    bench_reduce,
    bench_many_vars,
    bench_fibonacci,
    bench_closure_capture,
    bench_chess_fools_mate,
);
criterion_main!(benches);
