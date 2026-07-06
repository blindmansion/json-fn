# json-fn

json-fn is a pure JSON expression language. Programs are plain JSON values evaluated by a tree-walking interpreter.

It is a functional language: first-class functions, closures, currying, recursion (including mutual and locally-scoped), higher-order functions (`map`/`filter`/`reduce`/`sort`), and lazy order-independent local variables.

## Some snippets

Call a function. The first array element is the function, the rest are arguments:

```json
{ "$fn": ["add", 2, 3] }
```

Define a function. A body has `$params` and a `$return`; any other key (like `area` here) is a lazy local:

```json
{
  "$params": ["r"],
  "area": { "$fn": ["mul", 3.14159, { "$fn": ["mul", { "$var": "r" }, { "$var": "r" }] }] },
  "$return": { "$var": "area" }
}
```

Closures and currying. This returns a function; calling it with `[10]` yields a reusable "add 10" closure:

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] }
  }
}
```

Higher-order functions with inline callbacks. Squares each element, giving `[1, 4, 9, 16]`:

```json
{
  "$fn": [
    "map",
    { "$params": ["n"], "$return": { "$fn": ["mul", { "$var": "n" }, { "$var": "n" }] } },
    [1, 2, 3, 4]
  ]
}
```

Locally-scoped recursion. `fact` is a recursive helper visible only inside this body:

```json
{
  "$params": ["n"],
  "fact": {
    "$params": ["x"],
    "$return": {
      "$if": { "$lte": [{ "$var": "x" }, 1] },
      "$then": 1,
      "$else": { "$fn": ["mul", { "$var": "x" }, { "$fn": ["fact", { "$fn": ["sub", { "$var": "x" }, 1] }] }] }
    }
  },
  "$return": { "$fn": ["fact", { "$var": "n" }] }
}
```

For something much bigger, see [examples/chess.jsonc](examples/chess.jsonc), a full chess engine written entirely in json-fn.

## Usage

A host builds the standard library and evaluates a function body against arguments. In TypeScript:

```ts
import { callFunction, createStdlib } from "json-fn";

const functions = createStdlib();

const square = {
  $params: ["n"],
  $return: { $fn: ["mul", { $var: "n" }, { $var: "n" }] },
};

callFunction(square, [8], functions); // => 64
```

You can register your own functions by extending the registry (`{ ...functions, myFn }`) and pass execution limits as an optional argument. Limits cover a call-depth cap, a metered "fuel" work budget, a produced-value size cap, cooperative cancellation, and a host-only wall-clock timeout — see [docs/host-integration.md](docs/host-integration.md) for how to configure them (and [docs/execution-limits.md](docs/execution-limits.md) for the normative cost table). The Go, Python, and Rust implementations expose similar APIs.

## Language

See [docs/language.md](docs/language.md) for the full language reference.

## Conformance Tests

The [spec/cases/](spec/cases/) directory contains language-agnostic test suites as JSON files. Each file defines a suite of test cases with inputs and expected outputs. Every implementation should pass all of these.

## Examples

The [examples/](examples/) directory contains complete programs written in json-fn (`.jsonc` files), including a tic-tac-toe game with minimax AI and a chess engine.

## Implementations

json-fn has interpreters in [TypeScript](typescript/), [Go](go/), [Python](python/), and [Rust](rust/).

## Development

Run formatting and safe auto-fixes for every implementation:

```bash
./format-all.sh
```

Run all validation checks and tests for every implementation:

```bash
./test-all.sh
```

The validation script runs TypeScript checks/tests, Python lint/tests, Go vet/tests, and Rust clippy/tests.
