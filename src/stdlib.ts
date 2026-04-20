import { builtin, pure } from "./evaluate";
import type { FunctionRegistry } from "./types";

export function createStdlib(): FunctionRegistry {
  return {
    // Arithmetic
    add: pure((a: number, b: number) => a + b),
    sub: pure((a: number, b: number) => a - b),
    mul: pure((a: number, b: number) => a * b),
    div: pure((a: number, b: number) => {
      if (b === 0) throw new Error("div: division by zero");
      return a / b;
    }),
    mod: pure((a: number, b: number) => a % b),
    abs: pure((a: number) => Math.abs(a)),
    neg: pure((a: number) => -a),
    floor: pure((a: number) => Math.floor(a)),
    ceil: pure((a: number) => Math.ceil(a)),
    round: pure((a: number) => Math.round(a)),
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

    // Type checking
    isNull: pure((a: any) => a === null),
    isBool: pure((a: any) => typeof a === "boolean"),
    isNumber: pure((a: any) => typeof a === "number"),
    isString: pure((a: any) => typeof a === "string"),
    isArray: pure((a: any) => Array.isArray(a)),

    // Type coercion
    str: pure((a: any) => {
      if (typeof a === "string") return a;
      return JSON.stringify(a);
    }),
    num: pure((a: any) => {
      if (typeof a === "number") return a;
      if (typeof a === "boolean") return a ? 1 : 0;
      if (a === null) return 0;
      if (typeof a === "string") {
        const n = Number(a);
        if (Number.isNaN(n)) throw new Error(`num: cannot parse "${a}" as number`);
        return n;
      }
      throw new Error(`num: cannot convert ${typeof a} to number`);
    }),

    // Arrays
    length: pure((arr: any[] | string) => arr.length),
    head: pure((arr: any[]) => arr[0]),
    last: pure((arr: any[]) => arr[arr.length - 1] ?? null),
    tail: (arr: any[]) => arr.slice(1),
    concat: (a: any[], b: any[]) => [...a, ...b],
    range: (n: number) => Array.from({ length: n }, (_, i) => i),
    slice: (arr: any[] | string, start: number, end?: number) =>
      end === undefined ? arr.slice(start) : arr.slice(start, end),
    reverse: (arr: any[]) => [...arr].reverse(),
    includes: pure((arr: any[] | string, value: any) => arr.includes(value)),
    indexOf: pure((arr: any[] | string, value: any) =>
      (arr as any[]).indexOf(value),
    ),

    // Strings
    upper: pure((s: string) => s.toUpperCase()),
    lower: pure((s: string) => s.toLowerCase()),
    trim: pure((s: string) => s.trim()),
    strcat: pure((a: string, b: string) => a + b),
    split: (s: string, sep: string) => s.split(sep),
    join: pure((arr: any[], sep: string) => arr.join(sep)),

    // Object utilities
    keys: (obj: Record<string, any>) => Object.keys(obj),
    values: (obj: Record<string, any>) => Object.values(obj),

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
    find: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("find: second argument must be an array");
      for (let i = 0; i < arr.length; i++) {
        if (call(callback!, [arr[i]!, i])) return arr[i]!;
      }
      return null;
    }),
    findIndex: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("findIndex: second argument must be an array");
      for (let i = 0; i < arr.length; i++) {
        if (call(callback!, [arr[i]!, i])) return i;
      }
      return -1;
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
    sort: builtin((args, call) => {
      const [comparator, arr] = args;
      if (!Array.isArray(arr)) throw new Error("sort: second argument must be an array");
      return [...arr].sort((a, b) => call(comparator!, [a, b]) as number);
    }),
  };
}
