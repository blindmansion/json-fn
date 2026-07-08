import { builtin, pure, getArity } from "./utils";
import type { FunctionRegistry, JSONType } from "./types";
import { effectTask, pureTask, bindTask, isFnDecl, runHandle } from "./task";

export type LogFn = (value: JSONType, label?: string) => void;

export type StdlibOptions = {
  /**
   * Override the function used by `log`. Receives the value and an
   * optional label. Defaults to a no-op.
   */
  logger?: LogFn;
};

const noopLogger: LogFn = () => {};

const INLINE_FLAGS_RE = /^\(\?([imsu]*)\)/;
const VALID_FLAGS = new Set(["i", "m", "s", "u"]);

function parsePattern(pattern: string): RegExp {
  const flagMatch = INLINE_FLAGS_RE.exec(pattern);
  let flags = "";
  let source = pattern;
  if (flagMatch) {
    flags = flagMatch[1]!;
    source = pattern.slice(flagMatch[0].length);
    for (const f of flags) {
      if (!VALID_FLAGS.has(f)) throw new Error(`reTest: unsupported flag "${f}"`);
    }
  }
  return new RegExp(source, flags);
}

function buildMatchResult(m: RegExpExecArray): Record<string, any> {
  const named: Record<string, string> = {};
  if (m.groups) {
    for (const [k, v] of Object.entries(m.groups)) {
      named[k] = v ?? null;
    }
  }
  const groups: (string | null)[] = [];
  for (let i = 1; i < m.length; i++) {
    groups.push(m[i] ?? null);
  }
  return { match: m[0], index: m.index, groups, named };
}

function jsonEqual(a: JSONType, b: JSONType): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return typeof b === "boolean" && a === b;
  if (typeof a === "number" || typeof b === "number") return typeof b === "number" && a === b;
  if (typeof a === "string" || typeof b === "string") return typeof b === "string" && a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonEqual(v, b[i]!))
    );
  }

  const aEntries = Object.entries(a);
  const bObj = b as Record<string, JSONType>;
  return (
    aEntries.length === Object.keys(bObj).length &&
    aEntries.every(([k, v]) => Object.hasOwn(bObj, k) && jsonEqual(v, bObj[k]!))
  );
}

export function createStdlib(options: StdlibOptions = {}): FunctionRegistry {
  const log = options.logger ?? noopLogger;
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
    max: pure((arr: number[]) => {
      if (!Array.isArray(arr)) throw new Error("max: argument must be an array");
      return Math.max(...arr);
    }),
    min: pure((arr: number[]) => {
      if (!Array.isArray(arr)) throw new Error("min: argument must be an array");
      return Math.min(...arr);
    }),

    // Comparison. Equality is structural: json-fn values are immutable JSON, so
    // there is no observable reference identity to compare — deep equality is the
    // only well-founded, cross-implementation notion. On scalars it collapses to
    // `===` (see `jsonEqual`).
    eq: pure((a: JSONType, b: JSONType) => jsonEqual(a, b)),
    neq: pure((a: JSONType, b: JSONType) => !jsonEqual(a, b)),
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
    isTask: pure(
      (a: any) =>
        typeof a === "object" && a !== null && !Array.isArray(a) && typeof a["@task"] === "string",
    ),

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
    head: pure((arr: any[]) => arr[0] ?? null),
    last: pure((arr: any[]) => arr[arr.length - 1] ?? null),
    tail: pure((arr: any[]) => arr.slice(1)),
    concat: pure((...arrays: any[][]) => {
      const result: any[] = [];
      for (const arr of arrays) {
        for (const item of arr) result.push(item);
      }
      return result;
    }),
    range: builtin((args, _call, _functions, meter) => {
      const n = args[0];
      const len = typeof n === "number" && n > 0 ? Math.floor(n) : 0;
      meter.guardSize(len);
      meter.charge(len);
      return Array.from({ length: len }, (_, i) => i);
    }, 1),
    slice: pure((arr: any[] | string, start: number, end?: number) =>
      end === undefined ? arr.slice(start) : arr.slice(start, end),
    ),
    reverse: pure((arr: any[]) => [...arr].reverse()),
    // Membership uses the same structural equality as `eq` for array elements;
    // on strings these stay substring/char-index checks.
    includes: pure((arr: any[] | string, value: any) =>
      typeof arr === "string" ? arr.includes(value) : arr.some((el) => jsonEqual(el, value)),
    ),
    indexOf: pure((arr: any[] | string, value: any) =>
      typeof arr === "string" ? arr.indexOf(value) : arr.findIndex((el) => jsonEqual(el, value)),
    ),
    flatten: pure((arr: any[]) => arr.flat()),
    setAt: pure((arr: any[], idx: number, value: any) => {
      if (idx < 0 || idx >= arr.length)
        throw new Error(`setAt: index ${idx} out of bounds for array of length ${arr.length}`);
      const result = arr.slice();
      result[idx] = value;
      return result;
    }),

    // Strings
    upper: pure((s: string) => s.toUpperCase()),
    lower: pure((s: string) => s.toLowerCase()),
    trim: pure((s: string) => s.trim()),
    strcat: pure((...parts: string[]) => {
      for (const p of parts) {
        if (typeof p !== "string") throw new Error("strcat: arguments must be strings");
      }
      return parts.join("");
    }),
    split: pure((s: string, sep: string) => s.split(sep)),
    join: pure((arr: any[], sep: string) => arr.join(sep)),

    // Object utilities
    keys: pure((obj: Record<string, any>) => Object.keys(obj)),
    values: pure((obj: Record<string, any>) => Object.values(obj)),
    entries: pure((obj: Record<string, any>) => Object.entries(obj)),
    fromEntries: pure((pairs: [string, any][]) => Object.fromEntries(pairs)),
    merge: pure((a: Record<string, any>, b: Record<string, any>) => ({ ...a, ...b })),
    hasKey: pure((obj: Record<string, any>, key: string) => Object.hasOwn(obj, key)),
    isObject: pure((a: any) => typeof a === "object" && a !== null && !Array.isArray(a)),
    pick: pure((obj: Record<string, any>, ks: string[]) => {
      const result: Record<string, any> = {};
      for (const k of ks) if (k in obj) result[k] = obj[k];
      return result;
    }),
    omit: pure((obj: Record<string, any>, ks: string[]) => {
      const exclude = new Set(ks);
      const result: Record<string, any> = {};
      for (const k of Object.keys(obj)) if (!exclude.has(k)) result[k] = obj[k];
      return result;
    }),

    // Higher-order builtins (interpreter-aware — can invoke JSON callbacks).
    // Each charges fuel proportional to the number of elements it iterates over;
    // the per-callback cost is charged separately by the interpreter's call
    // chokepoint. See docs/execution-limits.md.
    map: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("map: second argument must be an array");
      meter.charge(arr.length);
      return arr.map((item, i) => call(callback!, [item, i]));
    }, 2),
    filter: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("filter: second argument must be an array");
      meter.charge(arr.length);
      return arr.filter((item, i) => call(callback!, [item, i]));
    }, 2),
    reduce: builtin((args, call, _functions, meter) => {
      const [callback, init, arr] = args as [any, any, any];
      if (!Array.isArray(arr)) throw new Error("reduce: third argument must be an array");
      meter.charge(arr.length);
      return arr.reduce((acc: any, item: any, i: number) => call(callback, [acc, item, i]), init);
    }, 3),
    find: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("find: second argument must be an array");
      meter.charge(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (call(callback!, [arr[i]!, i])) return arr[i]!;
      }
      return null;
    }, 2),
    findIndex: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("findIndex: second argument must be an array");
      meter.charge(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (call(callback!, [arr[i]!, i])) return i;
      }
      return -1;
    }, 2),
    some: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("some: second argument must be an array");
      meter.charge(arr.length);
      return arr.some((item, i) => call(callback!, [item, i]));
    }, 2),
    every: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("every: second argument must be an array");
      meter.charge(arr.length);
      return arr.every((item, i) => call(callback!, [item, i]));
    }, 2),
    sort: builtin((args, call, _functions, meter) => {
      const [comparator, arr] = args;
      if (!Array.isArray(arr)) throw new Error("sort: second argument must be an array");
      meter.charge(arr.length);
      return [...arr].sort((a, b) => call(comparator!, [a, b]) as number);
    }, 2),
    mapValues: builtin((args, call, _functions, meter) => {
      const [callback, obj] = args;
      if (typeof obj !== "object" || obj === null || Array.isArray(obj))
        throw new Error("mapValues: second argument must be an object");
      const entries = Object.entries(obj as Record<string, any>);
      meter.charge(entries.length);
      const result: Record<string, any> = {};
      for (const [k, v] of entries) {
        result[k] = call(callback!, [v, k]);
      }
      return result;
    }, 2),
    flatMap: builtin((args, call, _functions, meter) => {
      const [callback, arr] = args;
      if (!Array.isArray(arr)) throw new Error("flatMap: second argument must be an array");
      meter.charge(arr.length);
      const result: any[] = [];
      for (let i = 0; i < arr.length; i++) {
        const mapped = call(callback!, [arr[i]!, i]);
        if (Array.isArray(mapped)) {
          for (const item of mapped) result.push(item);
        } else {
          result.push(mapped);
        }
      }
      meter.guardSize(result.length);
      return result;
    }, 2),
    groupBy: builtin((args, call, _functions, meter) => {
      const [keyFn, arr] = args;
      if (!Array.isArray(arr)) throw new Error("groupBy: second argument must be an array");
      meter.charge(arr.length);
      const groups: Record<string, any[]> = {};
      for (let i = 0; i < arr.length; i++) {
        const key = call(keyFn!, [arr[i]!, i]) as string;
        if (typeof key !== "string" && typeof key !== "number")
          throw new Error(
            `groupBy: key function must return a string or number, got ${typeof key}`,
          );
        const k = String(key);
        if (!groups[k]) groups[k] = [];
        groups[k].push(arr[i]!);
      }
      return groups;
    }, 2),
    sortBy: builtin((args, call, _functions, meter) => {
      const [keyFn, arr] = args;
      if (!Array.isArray(arr)) throw new Error("sortBy: second argument must be an array");
      meter.charge(arr.length);
      const decorated = arr.map((item, i) => ({
        item,
        key: call(keyFn!, [item, i]) as string | number,
      }));
      decorated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return decorated.map((d) => d.item);
    }, 2),
    apply: builtin((args, call) => {
      const [fn, argsArray] = args;
      if (!Array.isArray(argsArray)) throw new Error("apply: second argument must be an array");
      return call(fn!, argsArray);
    }, 2),
    pipe: builtin((args, call, _functions, meter) => {
      const [fns, init] = args;
      if (!Array.isArray(fns))
        throw new Error("pipe: first argument must be an array of functions");
      meter.charge(fns.length);
      let value = init;
      for (const fn of fns) {
        value = call(fn!, [value!]);
      }
      return value!;
    }, 2),

    // Regex
    reTest: pure((pattern: string, str: string) => {
      return parsePattern(pattern).test(str);
    }),
    reMatch: pure((pattern: string, str: string) => {
      const re = parsePattern(pattern);
      const m = re.exec(str);
      if (!m) return null;
      return buildMatchResult(m);
    }),
    reMatchAll: pure((pattern: string, str: string) => {
      const re = parsePattern(pattern);
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      const results: Record<string, any>[] = [];
      let m: RegExpExecArray | null;
      while ((m = global.exec(str)) !== null) {
        results.push(buildMatchResult(m));
        if (m[0]!.length === 0) global.lastIndex++;
      }
      return results;
    }),
    reReplace: pure((pattern: string, replacement: string, str: string) => {
      const re = parsePattern(pattern);
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      return str.replace(global, replacement);
    }),
    reSplit: pure((pattern: string, str: string) => {
      return str.split(parsePattern(pattern));
    }),
    reReplaceWith: builtin((args, call, _functions, meter) => {
      const [pattern, callback, str] = args as [string, any, string];
      if (typeof pattern !== "string")
        throw new Error("reReplaceWith: first argument must be a pattern string");
      if (typeof str !== "string")
        throw new Error("reReplaceWith: third argument must be a string");
      meter.charge(str.length);
      const re = parsePattern(pattern);
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      const parts: string[] = [];
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = global.exec(str)) !== null) {
        parts.push(str.slice(lastIndex, m.index));
        const matchObj = buildMatchResult(m);
        const replaced = call(callback, [matchObj]);
        parts.push(String(replaced));
        lastIndex = m.index + m[0]!.length;
        if (m[0]!.length === 0) global.lastIndex++;
      }
      parts.push(str.slice(lastIndex));
      return parts.join("");
    }, 3),

    // Tasks & effects (see src/task.ts and docs/language.md "Tasks & Effects").
    // Constructors build inert, raw-marked tagged records; `handle` interprets
    // them in-language. `pure` the registry key coexists with the `pure` marker
    // helper imported above — one is an object key, the other an identifier.
    perform: builtin((args) => {
      const [name, effArgs] = args;
      if (typeof name !== "string")
        throw new Error("perform: first argument must be a string effect name");
      if (!Array.isArray(effArgs))
        throw new Error("perform: second argument must be an array of effect arguments");
      return effectTask(name, effArgs);
    }, 2),
    pure: builtin((args) => pureTask(args[0] ?? null), 1),
    bind: builtin((args) => {
      const [task, then] = args;
      if (!isFnDecl(then!)) throw new Error("bind: second argument must be a function");
      return bindTask(task!, then!);
    }, 2),
    raise: builtin((args) => effectTask("raise", [args[0] ?? null]), 1),
    handle: builtin(
      (args, call, _functions, meter) => runHandle(args[0]!, args[1]!, call, meter),
      2,
    ),

    // Introspection
    arity: builtin((args, _call, functions) => {
      return getArity(args[0], functions) ?? null;
    }, 1),

    // Debugging — logs the value (optionally with a label) and returns it unchanged (tap-style).
    log: pure((value: JSONType, label?: string) => {
      log(value, label);
      return value;
    }),
  };
}
