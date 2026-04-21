package jsonfn

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func loadChessFunctions(t *testing.T) FunctionRegistry {
	t.Helper()
	path := filepath.Join("..", "examples", "chess.jsonc")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Failed to read chess.jsonc: %v", err)
	}
	cleaned := StripJSONC(data)
	var gameFunctions map[string]any
	if err := json.Unmarshal(cleaned, &gameFunctions); err != nil {
		t.Fatalf("Failed to parse chess.jsonc: %v", err)
	}
	fns := CreateStdlib()
	for k, v := range gameFunctions {
		fns[k] = v
	}
	return fns
}

func callChess(t *testing.T, fns FunctionRegistry, name string, args ...any) any {
	t.Helper()
	body, ok := fns[name]
	if !ok {
		t.Fatalf("Function %s not found", name)
	}
	result, err := CallFunction(body, args, fns, nil)
	if err != nil {
		t.Fatalf("Error calling %s: %v", name, err)
	}
	return result
}

var initialBoard = []any{
	"R", "N", "B", "Q", "K", "B", "N", "R",
	"P", "P", "P", "P", "P", "P", "P", "P",
	nil, nil, nil, nil, nil, nil, nil, nil,
	nil, nil, nil, nil, nil, nil, nil, nil,
	nil, nil, nil, nil, nil, nil, nil, nil,
	nil, nil, nil, nil, nil, nil, nil, nil,
	"p", "p", "p", "p", "p", "p", "p", "p",
	"r", "n", "b", "q", "k", "b", "n", "r",
}

func newGameState() map[string]any {
	board := make([]any, 64)
	copy(board, initialBoard)
	return map[string]any{"board": board, "turn": "w", "status": "playing"}
}

// sq converts algebraic notation (e.g. "e2") to a board index.
func sq(s string) float64 {
	file := float64(s[0] - 'a')
	rank := float64(s[1] - '1')
	return rank*8 + file
}

func TestChessLoadFunctions(t *testing.T) {
	fns := loadChessFunctions(t)
	for _, name := range []string{
		"pieceColor", "pieceType", "otherColor", "rowOf", "colOf", "toIdx",
		"inBounds", "pieceMoves", "isAttacked", "findKing", "isInCheck",
		"applyMove", "isLegalMove", "hasAnyLegalMove", "getStatus", "playMove",
	} {
		if _, ok := fns[name]; !ok {
			t.Errorf("Expected function %s to be loaded", name)
		}
	}
}

func TestChessHelpers(t *testing.T) {
	fns := loadChessFunctions(t)

	t.Run("pieceColor", func(t *testing.T) {
		if c := callChess(t, fns, "pieceColor", "K"); c != "w" {
			t.Errorf("Expected w, got %v", c)
		}
		if c := callChess(t, fns, "pieceColor", "q"); c != "b" {
			t.Errorf("Expected b, got %v", c)
		}
		if c := callChess(t, fns, "pieceColor", nil); c != nil {
			t.Errorf("Expected nil, got %v", c)
		}
	})

	t.Run("otherColor", func(t *testing.T) {
		if c := callChess(t, fns, "otherColor", "w"); c != "b" {
			t.Errorf("Expected b, got %v", c)
		}
		if c := callChess(t, fns, "otherColor", "b"); c != "w" {
			t.Errorf("Expected w, got %v", c)
		}
	})

	t.Run("rowOf/colOf/toIdx", func(t *testing.T) {
		// a1 = index 0 → row 0, col 0
		if r := callChess(t, fns, "rowOf", float64(0)); r != float64(0) {
			t.Errorf("Expected row 0, got %v", r)
		}
		// h1 = index 7 → row 0, col 7
		if c := callChess(t, fns, "colOf", float64(7)); c != float64(7) {
			t.Errorf("Expected col 7, got %v", c)
		}
		// toIdx(3, 4) → 3*8+4 = 28
		if idx := callChess(t, fns, "toIdx", float64(3), float64(4)); idx != float64(28) {
			t.Errorf("Expected 28, got %v", idx)
		}
	})
}

func TestChessInitialPosition(t *testing.T) {
	fns := loadChessFunctions(t)
	state := newGameState()
	board := state["board"].([]any)

	t.Run("not in check at start", func(t *testing.T) {
		wCheck := callChess(t, fns, "isInCheck", board, "w")
		bCheck := callChess(t, fns, "isInCheck", board, "b")
		if wCheck != false {
			t.Error("White should not be in check at start")
		}
		if bCheck != false {
			t.Error("Black should not be in check at start")
		}
	})

	t.Run("status is playing", func(t *testing.T) {
		status := callChess(t, fns, "getStatus", board, "w")
		if status != "playing" {
			t.Errorf("Expected playing, got %v", status)
		}
	})

	t.Run("has legal moves", func(t *testing.T) {
		has := callChess(t, fns, "hasAnyLegalMove", board, "w")
		if has != true {
			t.Error("White should have legal moves at start")
		}
	})
}

func TestChessPlayMoves(t *testing.T) {
	fns := loadChessFunctions(t)

	t.Run("e2e4 opening", func(t *testing.T) {
		state := newGameState()
		result := callChess(t, fns, "playMove", state, sq("e2"), sq("e4"))
		newState := result.(map[string]any)
		if newState["turn"] != "b" {
			t.Error("Turn should switch to black after white moves")
		}
		if newState["status"] != "playing" {
			t.Errorf("Status should be playing, got %v", newState["status"])
		}
		board := newState["board"].([]any)
		if board[int(sq("e2"))] != nil {
			t.Error("e2 should be empty after e2e4")
		}
		if board[int(sq("e4"))] != "P" {
			t.Error("e4 should have white pawn after e2e4")
		}
	})

	t.Run("illegal move returns unchanged state", func(t *testing.T) {
		state := newGameState()
		result := callChess(t, fns, "playMove", state, sq("e2"), sq("e5"))
		newState := result.(map[string]any)
		if newState["turn"] != "w" {
			t.Error("Turn should remain white after illegal move")
		}
	})

	t.Run("sequence of moves", func(t *testing.T) {
		state := newGameState()
		moves := [][2]string{
			{"e2", "e4"}, // white
			{"e7", "e5"}, // black
			{"g1", "f3"}, // white knight
			{"b8", "c6"}, // black knight
		}
		for _, m := range moves {
			prevTurn := state["turn"]
			state = callChess(t, fns, "playMove", state, sq(m[0]), sq(m[1])).(map[string]any)
			if state["turn"] == prevTurn {
				t.Fatalf("Move %s%s should have been legal", m[0], m[1])
			}
		}
		if state["status"] != "playing" {
			t.Errorf("Expected playing after 4 moves, got %v", state["status"])
		}
	})
}

func TestChessCapture(t *testing.T) {
	fns := loadChessFunctions(t)

	// Set up a position where white pawn on e4 can capture black pawn on d5.
	board := make([]any, 64)
	board[int(sq("e1"))] = "K"
	board[int(sq("e8"))] = "k"
	board[int(sq("e4"))] = "P"
	board[int(sq("d5"))] = "p"
	state := map[string]any{"board": board, "turn": "w", "status": "playing"}

	result := callChess(t, fns, "playMove", state, sq("e4"), sq("d5"))
	newState := result.(map[string]any)
	if newState["turn"] != "b" {
		t.Error("Turn should switch to black after capture")
	}
	newBoard := newState["board"].([]any)
	if newBoard[int(sq("d5"))] != "P" {
		t.Error("White pawn should be on d5 after capture")
	}
	if newBoard[int(sq("e4"))] != nil {
		t.Error("e4 should be empty after pawn moved")
	}
}

func TestChessCheck(t *testing.T) {
	fns := loadChessFunctions(t)

	// White queen gives check to black king.
	board := make([]any, 64)
	board[int(sq("e1"))] = "K"
	board[int(sq("e8"))] = "k"
	board[int(sq("d1"))] = "Q" // queen on d1 doesn't give check yet

	inCheck := callChess(t, fns, "isInCheck", board, "b")
	if inCheck != false {
		t.Error("Black should not be in check with queen on d1")
	}

	// Move queen to e7 — gives check along e-file? No, queen on e7 checks
	// king on e8 diagonally? Actually queen on e7 attacks e8 directly.
	board2 := make([]any, 64)
	board2[int(sq("a1"))] = "K"
	board2[int(sq("e8"))] = "k"
	board2[int(sq("e7"))] = "Q"

	inCheck2 := callChess(t, fns, "isInCheck", board2, "b")
	if inCheck2 != true {
		t.Error("Black should be in check with queen on e7")
	}
}

func TestChessCheckmate(t *testing.T) {
	fns := loadChessFunctions(t)

	// Queen+King mate: Q on b7 (defended by K on c6) checkmates k on a8.
	// King escapes: a7 (queen), b8 (queen), b7 (can't capture — defended).
	board := make([]any, 64)
	board[int(sq("a8"))] = "k"
	board[int(sq("b7"))] = "Q"
	board[int(sq("c6"))] = "K"

	status := callChess(t, fns, "getStatus", board, "b")
	if status != "checkmate" {
		t.Errorf("Expected checkmate, got %v", status)
	}
}

func TestChessStalemate(t *testing.T) {
	fns := loadChessFunctions(t)

	// Classic stalemate: black king on a8, white queen on b6, white king on c1.
	// Black to move, no legal moves, not in check.
	board := make([]any, 64)
	board[int(sq("a8"))] = "k"
	board[int(sq("b6"))] = "Q"
	board[int(sq("c1"))] = "K"

	inCheck := callChess(t, fns, "isInCheck", board, "b")
	if inCheck != false {
		t.Error("Black should not be in check for stalemate")
	}

	status := callChess(t, fns, "getStatus", board, "b")
	if status != "stalemate" {
		t.Errorf("Expected stalemate, got %v", status)
	}
}

func TestChessPawnPromotion(t *testing.T) {
	fns := loadChessFunctions(t)

	// White pawn on e7, move to e8 should auto-promote to queen.
	board := make([]any, 64)
	board[int(sq("a1"))] = "K"
	board[int(sq("a8"))] = "k"
	board[int(sq("e7"))] = "P"

	newBoard := callChess(t, fns, "applyMove", board, sq("e7"), sq("e8")).([]any)
	if newBoard[int(sq("e8"))] != "Q" {
		t.Errorf("Expected white queen on e8 after promotion, got %v", newBoard[int(sq("e8"))])
	}
	if newBoard[int(sq("e7"))] != nil {
		t.Error("e7 should be empty after promotion move")
	}
}

func TestChessKnightMoves(t *testing.T) {
	fns := loadChessFunctions(t)

	// Knight on e4, empty board otherwise (plus kings).
	board := make([]any, 64)
	board[int(sq("e1"))] = "K"
	board[int(sq("e8"))] = "k"
	board[int(sq("e4"))] = "N"

	moves := callChess(t, fns, "pieceMoves", board, sq("e4")).([]any)
	// Knight on e4 (row 3, col 4) should have 8 possible moves:
	// d2, f2, c3, g3, c5, g5, d6, f6
	expected := map[float64]bool{
		sq("d2"): true, sq("f2"): true,
		sq("c3"): true, sq("g3"): true,
		sq("c5"): true, sq("g5"): true,
		sq("d6"): true, sq("f6"): true,
	}
	if len(moves) != 8 {
		t.Errorf("Knight on e4 should have 8 moves, got %d", len(moves))
	}
	for _, m := range moves {
		idx := m.(float64)
		if !expected[idx] {
			t.Errorf("Unexpected knight move target: %v", idx)
		}
	}
}

func TestChessFoolsMate(t *testing.T) {
	fns := loadChessFunctions(t)

	// Fool's mate: 1. f3 e5 2. g4 Qh4#
	state := newGameState()
	moves := [][2]string{
		{"f2", "f3"},
		{"e7", "e5"},
		{"g2", "g4"},
		{"d8", "h4"},
	}
	for _, m := range moves {
		prev := state["turn"]
		state = callChess(t, fns, "playMove", state, sq(m[0]), sq(m[1])).(map[string]any)
		if state["turn"] == prev {
			t.Fatalf("Move %s%s should have been legal", m[0], m[1])
		}
	}
	if state["status"] != "checkmate" {
		t.Errorf("Expected checkmate after fool's mate, got %v", state["status"])
	}
}
