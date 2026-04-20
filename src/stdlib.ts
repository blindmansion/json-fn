import { builtin, pure } from "./evaluate";
import type { FunctionRegistry } from "./types";

export function createStdlib(): FunctionRegistry {
  return {
    // Arithmetic
    add: pure((a: number, b: number) => a + b),
    sub: pure((a: number, b: number) => a - b),
    mul: pure((a: number, b: number) => a * b),
    mod: pure((a: number, b: number) => a % b),
    max: pure((arr: number[]) => Math.max(...arr)),
    min: pure((arr: number[]) => Math.min(...arr)),

    // Comparison
    eq: pure((a: any, b: any) => a === b),
    neq: pure((a: any, b: any) => a !== b),
    gt: pure((a: number, b: number) => a > b),
    gte: pure((a: number, b: number) => a >= b),
    lt: pure((a: number, b: number) => a < b),
    lte: pure((a: number, b: number) => a <= b),

    // Logic
    not: pure((a: boolean) => !a),
    and: pure((a: boolean, b: boolean) => a && b),
    or: pure((a: boolean, b: boolean) => a || b),

    // Arrays — read-only accessors are pure
    length: pure((arr: any[]) => arr.length),
    head: pure((arr: any[]) => arr[0]),
    tail: (arr: any[]) => arr.slice(1),
    concat: (a: any[], b: any[]) => [...a, ...b],
    range: (n: number) => Array.from({ length: n }, (_, i) => i),

    // Strings
    upper: pure((s: string) => s.toUpperCase()),
    strcat: pure((a: string, b: string) => a + b),

    // Higher-order builtins (interpreter-aware — can invoke JSON callbacks)
    map: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("map: second argument must be an array");
      return arr.map((item, i) => call(callback!, [item, i]));
    }),
    filter: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("filter: second argument must be an array");
      return arr.filter((item, i) => call(callback!, [item, i]));
    }),
    reduce: builtin((args, call) => {
      const [callback, init, arr] = args as [any, any, any];
      if (!Array.isArray(arr)) throw new Error("reduce: third argument must be an array");
      return arr.reduce((acc: any, item: any, i: number) => call(callback, [acc, item, i]), init);
    }),
    some: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("some: second argument must be an array");
      return arr.some((item, i) => call(callback!, [item, i]));
    }),
    every: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("every: second argument must be an array");
      return arr.every((item, i) => call(callback!, [item, i]));
    }),
  };
}
