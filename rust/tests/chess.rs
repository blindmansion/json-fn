//! Chess engine integration tests. Loads `examples/chess.jsonc` into the
//! Rust interpreter and runs the same scenarios as `go/chess_test.go`.

use std::fs;
use std::path::PathBuf;

use jsonfn::{FnEntry, FunctionRegistry, Value, call_function, create_stdlib, strip_jsonc};
use serde_json::{Map, json};

fn load_chess_functions() -> FunctionRegistry {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples")
        .join("chess.jsonc");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let cleaned = strip_jsonc(&raw);
    let game_functions: Map<String, Value> =
        serde_json::from_str(&cleaned).unwrap_or_else(|e| panic!("parse chess.jsonc: {e}"));
    let mut fns = create_stdlib();
    for (k, v) in game_functions {
        fns.insert(k, FnEntry::body(v));
    }
    fns
}

fn call_chess(fns: &FunctionRegistry, name: &str, args: &[Value]) -> Value {
    call_function(&Value::String(name.into()), args, fns, None)
        .unwrap_or_else(|e| panic!("call {name}: {e}"))
}

fn new_game_state(fns: &FunctionRegistry) -> Value {
    call_chess(fns, "newGame", &[])
}

fn empty_board() -> Vec<Value> {
    (0..64).map(|_| Value::Null).collect()
}

fn sq(s: &str) -> i64 {
    let bytes = s.as_bytes();
    let file = (bytes[0] - b'a') as i64;
    let rank = (bytes[1] - b'1') as i64;
    rank * 8 + file
}

fn sq_v(s: &str) -> Value {
    json!(sq(s))
}

#[test]
fn chess_load_functions() {
    let fns = load_chess_functions();
    for name in [
        // engine
        "pieceColor",
        "pieceType",
        "otherColor",
        "rowOf",
        "colOf",
        "toIdx",
        "inBounds",
        "pieceMoves",
        "isAttacked",
        "findKing",
        "isInCheck",
        "applyMove",
        "isLegalMove",
        "hasAnyLegalMove",
        "getStatus",
        "playMove",
        // CLI / parsing / display layer
        "newGame",
        "parseSquare",
        "squareName",
        "parseMove",
        "pieceGlyph",
        "formatRank",
        "formatBoard",
        "turnLabel",
        "statusLine",
        "boardSection",
        "showResult",
        "resetResult",
        "helpResult",
        "moveResult",
        "handleCommand",
    ] {
        assert!(fns.contains_key(name), "missing function: {name}");
    }
}

#[test]
fn chess_helpers() {
    let fns = load_chess_functions();
    assert_eq!(call_chess(&fns, "pieceColor", &[json!("K")]), json!("w"));
    assert_eq!(call_chess(&fns, "pieceColor", &[json!("q")]), json!("b"));
    assert_eq!(call_chess(&fns, "pieceColor", &[Value::Null]), Value::Null);

    assert_eq!(call_chess(&fns, "otherColor", &[json!("w")]), json!("b"));
    assert_eq!(call_chess(&fns, "otherColor", &[json!("b")]), json!("w"));

    assert_eq!(call_chess(&fns, "rowOf", &[json!(0)]), json!(0));
    assert_eq!(call_chess(&fns, "colOf", &[json!(7)]), json!(7));
    assert_eq!(call_chess(&fns, "toIdx", &[json!(3), json!(4)]), json!(28));
}

#[test]
fn chess_initial_position() {
    let fns = load_chess_functions();
    let state = new_game_state(&fns);
    let board = state["board"].clone();

    assert_eq!(
        call_chess(&fns, "isInCheck", &[board.clone(), json!("w")]),
        json!(false)
    );
    assert_eq!(
        call_chess(&fns, "isInCheck", &[board.clone(), json!("b")]),
        json!(false)
    );
    assert_eq!(
        call_chess(&fns, "getStatus", &[board.clone(), json!("w")]),
        json!("playing")
    );
    assert_eq!(
        call_chess(&fns, "hasAnyLegalMove", &[board, json!("w")]),
        json!(true)
    );
}

#[test]
fn chess_e2e4_opening() {
    let fns = load_chess_functions();
    let state = new_game_state(&fns);
    let result = call_chess(&fns, "playMove", &[state, sq_v("e2"), sq_v("e4")]);
    assert_eq!(result["turn"], json!("b"));
    assert_eq!(result["status"], json!("playing"));
    let board = result["board"].as_array().unwrap();
    assert_eq!(board[sq("e2") as usize], Value::Null);
    assert_eq!(board[sq("e4") as usize], json!("P"));
}

#[test]
fn chess_illegal_move_unchanged() {
    let fns = load_chess_functions();
    let state = new_game_state(&fns);
    let result = call_chess(&fns, "playMove", &[state, sq_v("e2"), sq_v("e5")]);
    assert_eq!(result["turn"], json!("w"));
}

#[test]
fn chess_capture() {
    let fns = load_chess_functions();
    let mut board = empty_board();
    board[sq("e1") as usize] = json!("K");
    board[sq("e8") as usize] = json!("k");
    board[sq("e4") as usize] = json!("P");
    board[sq("d5") as usize] = json!("p");
    let state = json!({ "board": board, "turn": "w", "status": "playing" });

    let result = call_chess(&fns, "playMove", &[state, sq_v("e4"), sq_v("d5")]);
    assert_eq!(result["turn"], json!("b"));
    let new_board = result["board"].as_array().unwrap();
    assert_eq!(new_board[sq("d5") as usize], json!("P"));
    assert_eq!(new_board[sq("e4") as usize], Value::Null);
}

#[test]
fn chess_check_and_checkmate() {
    let fns = load_chess_functions();

    let mut board = empty_board();
    board[sq("a1") as usize] = json!("K");
    board[sq("e8") as usize] = json!("k");
    board[sq("e7") as usize] = json!("Q");
    assert_eq!(
        call_chess(&fns, "isInCheck", &[Value::Array(board), json!("b")]),
        json!(true)
    );

    let mut board = empty_board();
    board[sq("a8") as usize] = json!("k");
    board[sq("b7") as usize] = json!("Q");
    board[sq("c6") as usize] = json!("K");
    assert_eq!(
        call_chess(&fns, "getStatus", &[Value::Array(board), json!("b")]),
        json!("checkmate")
    );
}

#[test]
fn chess_stalemate() {
    let fns = load_chess_functions();
    let mut board = empty_board();
    board[sq("a8") as usize] = json!("k");
    board[sq("b6") as usize] = json!("Q");
    board[sq("c1") as usize] = json!("K");
    assert_eq!(
        call_chess(
            &fns,
            "isInCheck",
            &[Value::Array(board.clone()), json!("b")]
        ),
        json!(false)
    );
    assert_eq!(
        call_chess(&fns, "getStatus", &[Value::Array(board), json!("b")]),
        json!("stalemate")
    );
}

#[test]
fn chess_pawn_promotion() {
    let fns = load_chess_functions();
    let mut board = empty_board();
    board[sq("a1") as usize] = json!("K");
    board[sq("a8") as usize] = json!("k");
    board[sq("e7") as usize] = json!("P");

    let new_board = call_chess(
        &fns,
        "applyMove",
        &[Value::Array(board), sq_v("e7"), sq_v("e8")],
    );
    let arr = new_board.as_array().unwrap();
    assert_eq!(arr[sq("e8") as usize], json!("Q"));
    assert_eq!(arr[sq("e7") as usize], Value::Null);
}

#[test]
fn chess_knight_moves() {
    let fns = load_chess_functions();
    let mut board = empty_board();
    board[sq("e1") as usize] = json!("K");
    board[sq("e8") as usize] = json!("k");
    board[sq("e4") as usize] = json!("N");

    let moves = call_chess(&fns, "pieceMoves", &[Value::Array(board), sq_v("e4")]);
    let moves = moves.as_array().unwrap();
    let expected: std::collections::HashSet<i64> = ["d2", "f2", "c3", "g3", "c5", "g5", "d6", "f6"]
        .iter()
        .map(|s| sq(s))
        .collect();
    assert_eq!(moves.len(), 8, "knight on e4 should have 8 moves");
    for m in moves {
        let i = m.as_i64().unwrap_or_else(|| m.as_f64().unwrap() as i64);
        assert!(expected.contains(&i), "unexpected knight target: {i}");
    }
}

#[test]
fn chess_fools_mate() {
    let fns = load_chess_functions();
    let mut state = new_game_state(&fns);
    let moves = [("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4")];
    for (from, to) in moves {
        let prev_turn = state["turn"].clone();
        state = call_chess(&fns, "playMove", &[state.clone(), sq_v(from), sq_v(to)]);
        assert_ne!(
            state["turn"], prev_turn,
            "move {from}{to} should have been legal"
        );
    }
    assert_eq!(state["status"], json!("checkmate"));
}
