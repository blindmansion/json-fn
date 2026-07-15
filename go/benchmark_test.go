package jsonfn

import (
	"fmt"
	"testing"
)

func makeDeepAdd(depth int) map[string]any {
	var expr any = float64(0)
	for range depth {
		expr = map[string]any{"$fn": []any{"add", expr, float64(1)}}
	}
	return map[string]any{"$return": expr}
}

func BenchmarkDeepArithmetic(b *testing.B) {
	for _, depth := range []int{100, 500, 1000, 5000} {
		program := makeDeepAdd(depth)
		stdlib := CreateStdlib()
		b.Run(fmt.Sprintf("depth=%d", depth), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(program, []any{}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkMapOverArrays(b *testing.B) {
	mapProgram := map[string]any{
		"$params": []any{"arr"},
		"$return": map[string]any{
			"$fn": []any{
				"map",
				map[string]any{
					"$params": []any{"x"},
					"$return": map[string]any{"$fn": []any{"add", map[string]any{"$var": "x"}, float64(1)}},
				},
				map[string]any{"$var": "arr"},
			},
		},
	}

	for _, size := range []int{100, 1000, 5000, 10000} {
		arr := make([]any, size)
		for i := range arr {
			arr[i] = float64(i)
		}
		stdlib := CreateStdlib()
		b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(mapProgram, []any{arr}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkNestedMap(b *testing.B) {
	nestedMapProgram := map[string]any{
		"$params": []any{"grid"},
		"$return": map[string]any{
			"$fn": []any{
				"map",
				map[string]any{
					"$params": []any{"row"},
					"$return": map[string]any{
						"$fn": []any{
							"map",
							map[string]any{
								"$params": []any{"x"},
								"$return": map[string]any{"$fn": []any{"add", map[string]any{"$var": "x"}, float64(1)}},
							},
							map[string]any{"$var": "row"},
						},
					},
				},
				map[string]any{"$var": "grid"},
			},
		},
	}

	for _, size := range []int{10, 50, 100} {
		grid := make([]any, size)
		for i := range grid {
			row := make([]any, size)
			for j := range row {
				row[j] = float64(j)
			}
			grid[i] = row
		}
		stdlib := CreateStdlib()
		b.Run(fmt.Sprintf("%dx%d", size, size), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(nestedMapProgram, []any{grid}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkReduce(b *testing.B) {
	sumProgram := map[string]any{
		"$params": []any{"arr"},
		"$return": map[string]any{
			"$fn": []any{
				"reduce",
				map[string]any{
					"$params": []any{"acc", "item"},
					"$return": map[string]any{"$fn": []any{"add", map[string]any{"$var": "acc"}, map[string]any{"$var": "item"}}},
				},
				float64(0),
				map[string]any{"$var": "arr"},
			},
		},
	}

	for _, size := range []int{100, 1000, 5000, 10000} {
		arr := make([]any, size)
		for i := range arr {
			arr[i] = float64(i)
		}
		stdlib := CreateStdlib()
		b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(sumProgram, []any{arr}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func makeManyVarsProgram(numVars int) map[string]any {
	body := map[string]any{}
	body["$params"] = []any{"v0"}
	for i := 1; i < numVars; i++ {
		body[fmt.Sprintf("v%d", i)] = map[string]any{
			"$fn": []any{"add", map[string]any{"$var": fmt.Sprintf("v%d", i-1)}, float64(1)},
		}
	}
	body["$return"] = map[string]any{"$var": fmt.Sprintf("v%d", numVars-1)}
	return body
}

func BenchmarkManyVars(b *testing.B) {
	for _, numVars := range []int{10, 50, 100, 500} {
		program := makeManyVarsProgram(numVars)
		stdlib := CreateStdlib()
		b.Run(fmt.Sprintf("vars=%d", numVars), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(program, []any{float64(0)}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkFibonacci(b *testing.B) {
	for _, n := range []int{10, 15, 20} {
		stdlib := CreateStdlib()
		stdlib["fib"] = map[string]any{
			"$params": []any{"n"},
			"$return": map[string]any{
				"$if":   map[string]any{"$fn": []any{"lte", map[string]any{"$var": "n"}, float64(1)}},
				"$then": map[string]any{"$var": "n"},
				"$else": map[string]any{
					"$fn": []any{
						"add",
						map[string]any{"$fn": []any{"fib", map[string]any{"$fn": []any{"sub", map[string]any{"$var": "n"}, float64(1)}}}},
						map[string]any{"$fn": []any{"fib", map[string]any{"$fn": []any{"sub", map[string]any{"$var": "n"}, float64(2)}}}},
					},
				},
			},
		}
		program := map[string]any{"$return": map[string]any{"$fn": []any{"fib", float64(n)}}}
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(program, []any{}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func makeClosureStress(capturedVars, arraySize int) map[string]any {
	body := map[string]any{}
	for i := 0; i < capturedVars; i++ {
		body[fmt.Sprintf("c%d", i)] = float64(i)
	}
	body["$return"] = map[string]any{
		"$fn": []any{
			"map",
			map[string]any{
				"$params": []any{"x"},
				"$return": map[string]any{"$fn": []any{"add", map[string]any{"$var": "x"}, map[string]any{"$var": "c0"}}},
			},
			map[string]any{"$fn": []any{"range", float64(arraySize)}},
		},
	}
	return body
}

func BenchmarkClosureCapture(b *testing.B) {
	cases := [][2]int{{5, 1000}, {50, 1000}, {200, 1000}, {5, 10000}, {50, 10000}}
	for _, c := range cases {
		vars, size := c[0], c[1]
		program := makeClosureStress(vars, size)
		stdlib := CreateStdlib()
		b.Run(fmt.Sprintf("vars=%d_arr=%d", vars, size), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(program, []any{}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func buildTicTacToeStdlib() FunctionRegistry {
	stdlib := CreateStdlib()

	stdlib["otherPlayer"] = map[string]any{
		"$params": []any{"player"},
		"$return": map[string]any{
			"$if":   map[string]any{"$fn": []any{"eq", map[string]any{"$var": "player"}, "X"}},
			"$then": "O",
			"$else": "X",
		},
	}

	stdlib["validMove"] = map[string]any{
		"$params": []any{"board", "pos"},
		"$return": map[string]any{
			"$fn": []any{"eq", map[string]any{"$var": "board", "$get": map[string]any{"$var": "pos"}}, nil},
		},
	}

	stdlib["makeMove"] = map[string]any{
		"$params": []any{"board", "pos", "player"},
		"$return": map[string]any{
			"$fn": []any{
				"map",
				map[string]any{
					"$params": []any{"cell", "idx"},
					"$return": map[string]any{
						"$if":   map[string]any{"$fn": []any{"eq", map[string]any{"$var": "idx"}, map[string]any{"$var": "pos"}}},
						"$then": map[string]any{"$var": "player"},
						"$else": map[string]any{"$var": "cell"},
					},
				},
				map[string]any{"$var": "board"},
			},
		},
	}

	stdlib["checkLine"] = map[string]any{
		"$params": []any{"board", "player", "line"},
		"$return": map[string]any{
			"$fn": []any{
				"every",
				map[string]any{
					"$params": []any{"pos"},
					"$return": map[string]any{
						"$fn": []any{"eq", map[string]any{"$var": "board", "$get": map[string]any{"$var": "pos"}}, map[string]any{"$var": "player"}},
					},
				},
				map[string]any{"$var": "line"},
			},
		},
	}

	stdlib["checkWin"] = map[string]any{
		"$params": []any{"board", "player"},
		"lines": map[string]any{
			"$raw": []any{
				[]any{float64(0), float64(1), float64(2)},
				[]any{float64(3), float64(4), float64(5)},
				[]any{float64(6), float64(7), float64(8)},
				[]any{float64(0), float64(3), float64(6)},
				[]any{float64(1), float64(4), float64(7)},
				[]any{float64(2), float64(5), float64(8)},
				[]any{float64(0), float64(4), float64(8)},
				[]any{float64(2), float64(4), float64(6)},
			},
		},
		"$return": map[string]any{
			"$fn": []any{
				"some",
				map[string]any{
					"$params": []any{"line"},
					"$return": map[string]any{
						"$fn": []any{"checkLine", map[string]any{"$var": "board"}, map[string]any{"$var": "player"}, map[string]any{"$var": "line"}},
					},
				},
				map[string]any{"$var": "lines"},
			},
		},
	}

	stdlib["isBoardFull"] = map[string]any{
		"$params": []any{"board"},
		"$return": map[string]any{
			"$fn": []any{
				"every",
				map[string]any{
					"$params": []any{"cell"},
					"$return": map[string]any{"$fn": []any{"neq", map[string]any{"$var": "cell"}, nil}},
				},
				map[string]any{"$var": "board"},
			},
		},
	}

	stdlib["getStatus"] = map[string]any{
		"$params": []any{"board"},
		"xWins":   map[string]any{"$fn": []any{"checkWin", map[string]any{"$var": "board"}, "X"}},
		"oWins":   map[string]any{"$fn": []any{"checkWin", map[string]any{"$var": "board"}, "O"}},
		"full":    map[string]any{"$fn": []any{"isBoardFull", map[string]any{"$var": "board"}}},
		"$return": map[string]any{
			"$cond": []any{
				[]any{map[string]any{"$var": "xWins"}, "X"},
				[]any{map[string]any{"$var": "oWins"}, "O"},
				[]any{map[string]any{"$var": "full"}, "draw"},
				[]any{true, "playing"},
			},
		},
	}

	stdlib["minimax"] = map[string]any{
		"$params":  []any{"board", "depth", "isMaximizing", "aiPlayer"},
		"opponent": map[string]any{"$fn": []any{"otherPlayer", map[string]any{"$var": "aiPlayer"}}},
		"status":   map[string]any{"$fn": []any{"getStatus", map[string]any{"$var": "board"}}},
		"gameOver": map[string]any{"$fn": []any{"neq", map[string]any{"$var": "status"}, "playing"}},
		"aiWins": map[string]any{
			"$fn": []any{"and", map[string]any{"$var": "gameOver"}, map[string]any{"$fn": []any{"eq", map[string]any{"$var": "status"}, map[string]any{"$var": "aiPlayer"}}}},
		},
		"opponentWins": map[string]any{
			"$fn": []any{"and", map[string]any{"$var": "gameOver"}, map[string]any{"$fn": []any{"eq", map[string]any{"$var": "status"}, map[string]any{"$var": "opponent"}}}},
		},
		"currentPlayer": map[string]any{
			"$if":   map[string]any{"$var": "isMaximizing"},
			"$then": map[string]any{"$var": "aiPlayer"},
			"$else": map[string]any{"$var": "opponent"},
		},
		"emptyPos": map[string]any{
			"$fn": []any{
				"filter",
				map[string]any{
					"$params": []any{"pos"},
					"$return": map[string]any{"$fn": []any{"validMove", map[string]any{"$var": "board"}, map[string]any{"$var": "pos"}}},
				},
				map[string]any{"$fn": []any{"range", float64(9)}},
			},
		},
		"scores": map[string]any{
			"$fn": []any{
				"map",
				map[string]any{
					"$params": []any{"pos"},
					"$return": map[string]any{
						"$fn": []any{
							"minimax",
							map[string]any{
								"$fn": []any{"makeMove", map[string]any{"$var": "board"}, map[string]any{"$var": "pos"}, map[string]any{"$var": "currentPlayer"}},
							},
							map[string]any{"$fn": []any{"add", map[string]any{"$var": "depth"}, float64(1)}},
							map[string]any{"$fn": []any{"not", map[string]any{"$var": "isMaximizing"}}},
							map[string]any{"$var": "aiPlayer"},
						},
					},
				},
				map[string]any{"$var": "emptyPos"},
			},
		},
		"maxScore": map[string]any{"$fn": []any{"max", map[string]any{"$var": "scores"}}},
		"minScore": map[string]any{"$fn": []any{"min", map[string]any{"$var": "scores"}}},
		"$return": map[string]any{
			"$cond": []any{
				[]any{map[string]any{"$var": "aiWins"}, map[string]any{"$fn": []any{"sub", float64(10), map[string]any{"$var": "depth"}}}},
				[]any{map[string]any{"$var": "opponentWins"}, map[string]any{"$fn": []any{"sub", map[string]any{"$var": "depth"}, float64(10)}}},
				[]any{map[string]any{"$var": "gameOver"}, float64(0)},
				[]any{map[string]any{"$var": "isMaximizing"}, map[string]any{"$var": "maxScore"}},
				[]any{true, map[string]any{"$var": "minScore"}},
			},
		},
	}

	stdlib["bestMove"] = map[string]any{
		"$params": []any{"board", "aiPlayer"},
		"emptyPos": map[string]any{
			"$fn": []any{
				"filter",
				map[string]any{
					"$params": []any{"pos"},
					"$return": map[string]any{"$fn": []any{"validMove", map[string]any{"$var": "board"}, map[string]any{"$var": "pos"}}},
				},
				map[string]any{"$fn": []any{"range", float64(9)}},
			},
		},
		"best": map[string]any{
			"$fn": []any{
				"reduce",
				map[string]any{
					"$params": []any{"acc", "pos"},
					"newBoard": map[string]any{
						"$fn": []any{"makeMove", map[string]any{"$var": "board"}, map[string]any{"$var": "pos"}, map[string]any{"$var": "aiPlayer"}},
					},
					"score": map[string]any{
						"$fn": []any{"minimax", map[string]any{"$var": "newBoard"}, float64(1), false, map[string]any{"$var": "aiPlayer"}},
					},
					"bestScore": map[string]any{"$var": "acc", "$get": "score"},
					"$return": map[string]any{
						"$if":   map[string]any{"$fn": []any{"gt", map[string]any{"$var": "score"}, map[string]any{"$var": "bestScore"}}},
						"$then": map[string]any{"score": map[string]any{"$var": "score"}, "pos": map[string]any{"$var": "pos"}},
						"$else": map[string]any{"$var": "acc"},
					},
				},
				map[string]any{"$raw": map[string]any{"score": float64(-100), "pos": float64(-1)}},
				map[string]any{"$var": "emptyPos"},
			},
		},
		"$return": map[string]any{"$var": "best", "$get": "pos"},
	}

	return stdlib
}

func BenchmarkTicTacToe5Empty(b *testing.B) {
	stdlib := buildTicTacToeStdlib()
	board := []any{"O", nil, "X", nil, "X", nil, "O", nil, nil}
	program := map[string]any{"$return": map[string]any{"$fn": []any{"bestMove", board, "O"}}}

	for b.Loop() {
		_, err := CallFunction(program, []any{}, stdlib, nil)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTicTacToe7Empty(b *testing.B) {
	stdlib := buildTicTacToeStdlib()
	board := []any{"X", nil, nil, nil, nil, nil, nil, nil, "O"}
	program := map[string]any{"$return": map[string]any{"$fn": []any{"bestMove", board, "O"}}}

	for b.Loop() {
		_, err := CallFunction(program, []any{}, stdlib, nil)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPipeline(b *testing.B) {
	stdlib := CreateStdlib()
	stdlib["double"] = map[string]any{
		"$params": []any{"x"},
		"$return": map[string]any{"$fn": []any{"mul", map[string]any{"$var": "x"}, float64(2)}},
	}
	stdlib["addTen"] = map[string]any{
		"$params": []any{"x"},
		"$return": map[string]any{"$fn": []any{"add", map[string]any{"$var": "x"}, float64(10)}},
	}
	stdlib["square"] = map[string]any{
		"$params": []any{"x"},
		"$return": map[string]any{"$fn": []any{"mul", map[string]any{"$var": "x"}, map[string]any{"$var": "x"}}},
	}

	pipeProgram := map[string]any{
		"$params": []any{"arr"},
		"$return": map[string]any{
			"$fn": []any{
				"map",
				map[string]any{
					"$params": []any{"x"},
					"$return": map[string]any{
						"$fn": []any{"pipe", []any{"double", "addTen", "square"}, map[string]any{"$var": "x"}},
					},
				},
				map[string]any{"$var": "arr"},
			},
		},
	}

	for _, size := range []int{100, 1000, 5000} {
		arr := make([]any, size)
		for i := range arr {
			arr[i] = float64(i)
		}
		b.Run(fmt.Sprintf("size=%d", size), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := CallFunction(pipeProgram, []any{arr}, stdlib, nil)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
