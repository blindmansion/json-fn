"""End-to-end test using ``examples/chess.jsonc``.

Loads the chess engine (~860 lines of pure json-fn), strips JSONC comments,
and plays the four-move "Fool's Mate" sequence verifying the final game
status is ``"checkmate"``. Mirrors the equivalent Go test
(``go/chess_test.go::TestChessFoolsMate``).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jsonfn import call_function, create_stdlib, strip_jsonc

CHESS_PATH = Path(__file__).resolve().parent.parent.parent / "examples" / "chess.jsonc"


def _sq(s: str) -> int:
    """Convert algebraic notation (e.g. ``"e2"``) to a 0-63 board index."""
    file_ = ord(s[0]) - ord("a")
    rank = ord(s[1]) - ord("1")
    return rank * 8 + file_


@pytest.fixture(scope="module")
def chess_registry() -> dict[str, object]:
    if not CHESS_PATH.is_file():
        pytest.skip(f"chess example not found at {CHESS_PATH}")
    cleaned = strip_jsonc(CHESS_PATH.read_text(encoding="utf-8"))
    fns = json.loads(cleaned)
    registry = create_stdlib()
    registry.update(fns)
    return registry


def _call(registry: dict[str, object], name: str, *args: object) -> object:
    body = registry[name]
    if not isinstance(body, dict):
        raise AssertionError(f"{name!r} is not a json-fn function body")
    return call_function(body, list(args), registry)


def _new_state(registry: dict[str, object]) -> dict[str, object]:
    state = _call(registry, "newGame")
    assert isinstance(state, dict)
    return state


def test_chess_loads_expected_functions(chess_registry: dict[str, object]) -> None:
    expected = [
        # engine
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
        # CLI / parsing / display layer
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
    ]
    missing = [name for name in expected if name not in chess_registry]
    assert not missing, f"chess functions missing from registry: {missing}"


def test_chess_initial_position_not_in_check(chess_registry: dict[str, object]) -> None:
    state = _new_state(chess_registry)
    board = state["board"]
    assert _call(chess_registry, "isInCheck", board, "w") is False
    assert _call(chess_registry, "isInCheck", board, "b") is False
    assert _call(chess_registry, "getStatus", board, "w") == "playing"


def test_chess_e2e4_opening(chess_registry: dict[str, object]) -> None:
    state = _new_state(chess_registry)
    new_state = _call(chess_registry, "playMove", state, _sq("e2"), _sq("e4"))
    assert isinstance(new_state, dict)
    assert new_state["turn"] == "b"
    assert new_state["status"] == "playing"
    new_board = new_state["board"]
    assert isinstance(new_board, list)
    assert new_board[_sq("e2")] is None
    assert new_board[_sq("e4")] == "P"


def test_chess_fools_mate(chess_registry: dict[str, object]) -> None:
    """1. f3 e5  2. g4 Qh4#  → checkmate."""
    state: object = _new_state(chess_registry)
    moves = [("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4")]
    for src, dst in moves:
        assert isinstance(state, dict)
        prev_turn = state["turn"]
        state = _call(chess_registry, "playMove", state, _sq(src), _sq(dst))
        assert isinstance(state, dict)
        assert state["turn"] != prev_turn, f"{src}{dst} should have been a legal move"
    assert isinstance(state, dict)
    assert state["status"] == "checkmate", (
        f"expected checkmate after fool's mate, got {state['status']!r}"
    )
