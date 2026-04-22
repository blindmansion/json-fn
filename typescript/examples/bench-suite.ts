import { callFunction, createStdlib, type JSONType } from "../src";
import type { FunctionDeclaration } from "../src/types";

const functions: Record<string, any> = createStdlib();

function bench(label: string, fn: () => void, iterations: number): void {
  for (let i = 0; i < Math.min(3, iterations); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = (performance.now() - t0) * 1000; // µs
  const perOp = elapsed / iterations;
  console.log(`${label.padEnd(35)} ${perOp.toFixed(2).padStart(12)} µs/op  (${iterations} iters)`);
}

function makeDeepAdd(depth: number): JSONType {
  let expr: JSONType = 0;
  for (let i = 0; i < depth; i++) expr = { $fn: ["add", expr, 1] };
  return { $return: expr };
}

console.log("── deep_arithmetic ──");
for (const depth of [100, 500, 1000, 5000]) {
  const program = makeDeepAdd(depth) as FunctionDeclaration;
  const iters = depth <= 500 ? 500 : depth <= 1000 ? 200 : 50;
  bench(`deep_arithmetic/depth=${depth}`, () => callFunction(program, [], functions), iters);
}

const mapProgram = {
  $params: ["arr"],
  $return: {
    $fn: ["map", { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, 1] } }, { $var: "arr" }],
  },
} as FunctionDeclaration;

console.log("\n── map_over_arrays ──");
for (const size of [100, 1000, 5000, 10000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  const iters = size <= 1000 ? 200 : 50;
  bench(`map_over_arrays/size=${size}`, () => callFunction(mapProgram, [arr], functions), iters);
}

const nestedMapProgram = {
  $params: ["grid"],
  $return: {
    $fn: [
      "map",
      {
        $params: ["row"],
        $return: {
          $fn: [
            "map",
            { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, 1] } },
            { $var: "row" },
          ],
        },
      },
      { $var: "grid" },
    ],
  },
} as FunctionDeclaration;

console.log("\n── nested_map ──");
for (const size of [10, 50, 100]) {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, (_, i) => i));
  const iters = size === 10 ? 500 : size === 50 ? 100 : 30;
  bench(`nested_map/${size}x${size}`, () => callFunction(nestedMapProgram, [grid], functions), iters);
}

const reduceProgram = {
  $params: ["arr"],
  $return: {
    $fn: [
      "reduce",
      {
        $params: ["acc", "item"],
        $return: { $fn: ["add", { $var: "acc" }, { $var: "item" }] },
      },
      0,
      { $var: "arr" },
    ],
  },
} as FunctionDeclaration;

console.log("\n── reduce ──");
for (const size of [100, 1000, 5000, 10000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  const iters = size <= 1000 ? 200 : 50;
  bench(`reduce/size=${size}`, () => callFunction(reduceProgram, [arr], functions), iters);
}

functions.fib = {
  $params: ["n"],
  $return: {
    $if: { $fn: ["lte", { $var: "n" }, 1] },
    $then: { $var: "n" },
    $else: {
      $fn: [
        "add",
        { $fn: ["fib", { $fn: ["sub", { $var: "n" }, 1] }] },
        { $fn: ["fib", { $fn: ["sub", { $var: "n" }, 2] }] },
      ],
    },
  },
};

console.log("\n── fibonacci ──");
for (const n of [10, 15, 20]) {
  const program = { $return: { $fn: ["fib", n] } } as FunctionDeclaration;
  const iters = n === 10 ? 200 : n === 15 ? 30 : 5;
  bench(`fibonacci/n=${n}`, () => callFunction(program, [], functions), iters);
}
