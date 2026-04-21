import { builtin, pure, getArity } from "./utils";
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
    indexOf: pure((arr: any[] | string, value: any) => (arr as any[]).indexOf(value)),
    flatten: (arr: any[]) => arr.flat(),

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
    entries: (obj: Record<string, any>) => Object.entries(obj),
    fromEntries: (pairs: [string, any][]) => Object.fromEntries(pairs),
    merge: (a: Record<string, any>, b: Record<string, any>) => ({ ...a, ...b }),
    hasKey: pure((obj: Record<string, any>, key: string) => Object.hasOwn(obj, key)),
    isObject: pure(
      (a: any) => typeof a === "object" && a !== null && !Array.isArray(a),
    ),
    pick: (obj: Record<string, any>, ks: string[]) => {
      const result: Record<string, any> = {};
      for (const k of ks) if (k in obj) result[k] = obj[k];
      return result;
    },
    omit: (obj: Record<string, any>, ks: string[]) => {
      const exclude = new Set(ks);
      const result: Record<string, any> = {};
      for (const k of Object.keys(obj)) if (!exclude.has(k)) result[k] = obj[k];
      return result;
    },

    // Higher-order builtins (interpreter-aware — can invoke JSON callbacks)
    map: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("map: second argument must be an array");
      return arr.map((item, i) => call(callback!, [item, i]));
    }, 2),
    filter: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("filter: second argument must be an array");
      return arr.filter((item, i) => call(callback!, [item, i]));
    }, 2),
    reduce: builtin((args, call) => {
      const [callback, init, arr] = args as [any, any, any];
      if (!Array.isArray(arr)) throw new Error("reduce: third argument must be an array");
      return arr.reduce((acc: any, item: any, i: number) => call(callback, [acc, item, i]), init);
    }, 3),
    find: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("find: second argument must be an array");
      for (let i = 0; i < arr.length; i++) {
        if (call(callback!, [arr[i]!, i])) return arr[i]!;
      }
      return null;
    }, 2),
    findIndex: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("findIndex: second argument must be an array");
      for (let i = 0; i < arr.length; i++) {
        if (call(callback!, [arr[i]!, i])) return i;
      }
      return -1;
    }, 2),
    some: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("some: second argument must be an array");
      return arr.some((item, i) => call(callback!, [item, i]));
    }, 2),
    every: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("every: second argument must be an array");
      return arr.every((item, i) => call(callback!, [item, i]));
    }, 2),
    sort: builtin((args, call) => {
      const [comparator, arr] = args;
      if (!Array.isArray(arr)) throw new Error("sort: second argument must be an array");
      return [...arr].sort((a, b) => call(comparator!, [a, b]) as number);
    }, 2),
    mapValues: builtin((args, call) => {
      const [callback, obj] = args;
      if (typeof obj !== "object" || obj === null || Array.isArray(obj))
        throw new Error("mapValues: second argument must be an object");
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj as Record<string, any>)) {
        result[k] = call(callback!, [v, k]);
      }
      return result;
    }, 2),
    flatMap: builtin((args, call) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("flatMap: second argument must be an array");
      const result: any[] = [];
      for (let i = 0; i < arr.length; i++) {
        const mapped = call(callback!, [arr[i]!, i]);
        if (Array.isArray(mapped)) {
          for (const item of mapped) result.push(item);
        } else {
          result.push(mapped);
        }
      }
      return result;
    }, 2),
    groupBy: builtin((args, call) => {
      const [keyFn, arr] = args;
      if (!Array.isArray(arr)) throw new Error("groupBy: second argument must be an array");
      const groups: Record<string, any[]> = {};
      for (let i = 0; i < arr.length; i++) {
        const key = call(keyFn!, [arr[i]!, i]) as string;
        if (typeof key !== "string" && typeof key !== "number")
          throw new Error(`groupBy: key function must return a string or number, got ${typeof key}`);
        const k = String(key);
        if (!groups[k]) groups[k] = [];
        groups[k].push(arr[i]!);
      }
      return groups;
    }, 2),
    sortBy: builtin((args, call) => {
      const [keyFn, arr] = args;
      if (!Array.isArray(arr)) throw new Error("sortBy: second argument must be an array");
      const decorated = arr.map((item, i) => ({ item, key: call(keyFn!, [item, i]) as string | number }));
      decorated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return decorated.map((d) => d.item);
    }, 2),
    pipe: builtin((args, call) => {
      const [fns, init] = args;
      if (!Array.isArray(fns)) throw new Error("pipe: first argument must be an array of functions");
      let value = init;
      for (const fn of fns) {
        value = call(fn!, [value!]);
      }
      return value!;
    }, 2),

    // Introspection
    arity: builtin((args, _call, functions) => {
      return getArity(args[0], functions) ?? null;
    }, 1),
  };
}
