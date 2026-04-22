//! Loads `examples/chess.jsonc` and plays Fool's Mate, printing each board.
//! Run with: `cargo run --example chess --release`

use std::fs;
use std::path::PathBuf;

use jsonfn::{
    FnEntry, FunctionRegistry, Value, call_function, create_stdlib, strip_jsonc,
};
use serde_json::{Map, json};

fn main() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples")
        .join("chess.jsonc");
    let raw = fs::read_to_string(&path).expect("read chess.jsonc");
    let cleaned = strip_jsonc(&raw);
    let game: Map<String, Value> = serde_json::from_str(&cleaned).expect("parse chess.jsonc");
    let mut fns: FunctionRegistry = create_stdlib();
    for (k, v) in game {
        fns.insert(k, FnEntry::body(v));
    }

    let mut state = json!({
        "board": (0..64).map(|i| initial_square(i)).collect::<Vec<_>>(),
        "turn": "w",
        "status": "playing"
    });

    println!("Initial position:");
    print_board(&state["board"]);

    let moves = [("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4")];
    for (from, to) in moves {
        let from_v = json!(sq(from));
        let to_v = json!(sq(to));
        state = call_function(
            &Value::String("playMove".into()),
            &[state.clone(), from_v, to_v],
            &fns,
            None,
        )
        .expect("playMove");
        println!("\nAfter {from}{to} (turn: {}, status: {}):", state["turn"], state["status"]);
        print_board(&state["board"]);
    }

    println!("\nFinal status: {}", state["status"]);
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

fn print_board(board: &Value) {
    let arr = board.as_array().unwrap();
    for row in (0..8).rev() {
        print!(" {}  ", row + 1);
        for col in 0..8 {
            let i = (row * 8 + col) as usize;
            let s = match &arr[i] {
                Value::String(s) => s.as_str(),
                _ => ".",
            };
            print!(" {s}");
        }
        println!();
    }
    println!("     a b c d e f g h");
}
