import { builtin, pure, getArity } from "./utils";
import type { BuiltinFunction, FunctionRegistry, JSONType, Meter } from "./types";
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

function finiteMathResult(name: string, result: number): number {
  if (!Number.isFinite(result)) throw new Error(`${name}: result must be a finite number`);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, JSONType> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string, meter: Meter): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  while (true) {
    const l = left.next();
    const r = right.next();
    meter.charge(1);
    if (l.done || r.done) return l.done === r.done ? 0 : l.done ? -1 : 1;
    const lCodePoint = l.value.codePointAt(0)!;
    const rCodePoint = r.value.codePointAt(0)!;
    if (lCodePoint !== rCodePoint) return lCodePoint < rCodePoint ? -1 : 1;
  }
}

function callbackArgs(item: JSONType, index: number, indexed: boolean): JSONType[] {
  return indexed ? [item, index] : [item];
}

function reduceCallbackArgs(
  accumulator: JSONType,
  item: JSONType,
  index: number,
  indexed: boolean,
): JSONType[] {
  return indexed ? [accumulator, item, index] : [accumulator, item];
}

function arrayMapBuiltin(name: string, indexed: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    return arr.map((item, index) => call(callback!, callbackArgs(item, index, indexed)));
  }, 2);
}

function arrayFilterBuiltin(name: string, indexed: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    return arr.filter((item, index) => call(callback!, callbackArgs(item, index, indexed)));
  }, 2);
}

function arrayReduceBuiltin(name: string, indexed: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [callback, init, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: third argument must be an array`);
    meter.charge(arr.length);
    return arr.reduce(
      (accumulator: JSONType, item: JSONType, index: number) =>
        call(callback!, reduceCallbackArgs(accumulator, item, index, indexed)),
      init!,
    );
  }, 3);
}

function arrayFindBuiltin(name: string, indexed: boolean, returnIndex: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    for (let index = 0; index < arr.length; index++) {
      if (call(callback!, callbackArgs(arr[index]!, index, indexed))) {
        return returnIndex ? index : arr[index]!;
      }
    }
    return null;
  }, 2);
}

function arrayQuantifierBuiltin(
  name: string,
  indexed: boolean,
  mode: "some" | "every" | "count",
): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    if (mode === "some") {
      return arr.some((item, index) => call(callback!, callbackArgs(item, index, indexed)));
    }
    if (mode === "every") {
      return arr.every((item, index) => call(callback!, callbackArgs(item, index, indexed)));
    }
    let matches = 0;
    for (let index = 0; index < arr.length; index++) {
      if (call(callback!, callbackArgs(arr[index]!, index, indexed))) matches++;
    }
    return matches;
  }, 2);
}

function arrayFlatMapBuiltin(name: string, indexed: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    const result: JSONType[] = [];
    for (let index = 0; index < arr.length; index++) {
      const mapped = call(callback!, callbackArgs(arr[index]!, index, indexed));
      if (Array.isArray(mapped)) result.push(...mapped);
      else result.push(mapped);
    }
    meter.guardSize(result.length);
    return result;
  }, 2);
}

function arrayGroupByBuiltin(name: string, indexed: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [keyFn, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    const groups: Record<string, JSONType[]> = {};
    for (let index = 0; index < arr.length; index++) {
      const key = call(keyFn!, callbackArgs(arr[index]!, index, indexed));
      if (typeof key !== "string" && typeof key !== "number") {
        throw new Error(`${name}: key function must return a string or number, got ${typeof key}`);
      }
      const normalizedKey = String(key);
      if (!groups[normalizedKey]) groups[normalizedKey] = [];
      groups[normalizedKey].push(arr[index]!);
    }
    return groups;
  }, 2);
}

function arraySortByBuiltin(name: string, indexed: boolean): BuiltinFunction {
  return builtin((args, call, _functions, meter) => {
    const [keyFn, arr] = args;
    if (!Array.isArray(arr)) throw new Error(`${name}: second argument must be an array`);
    meter.charge(arr.length);
    let keyKind: "number" | "string" | undefined;
    const decorated: { item: JSONType; key: number | string }[] = [];
    for (let index = 0; index < arr.length; index++) {
      const item = arr[index]!;
      const key = call(keyFn!, callbackArgs(item, index, indexed));
      if (
        (typeof key !== "number" && typeof key !== "string") ||
        (typeof key === "number" && !Number.isFinite(key))
      ) {
        throw new Error(`${name}: key function must return a finite number or string`);
      }
      const kind: "number" | "string" = typeof key === "number" ? "number" : "string";
      if (keyKind === undefined) keyKind = kind;
      if (kind !== keyKind) {
        throw new Error(`${name}: key function must return keys of one consistent type`);
      }
      decorated.push({ item, key });
    }
    decorated.sort((a, b) => {
      if (keyKind === "string") return compareStrings(a.key as string, b.key as string, meter);
      meter.charge(1);
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return decorated.map(({ item }) => item);
  }, 2);
}

export function createStdlib(options: StdlibOptions = {}): FunctionRegistry {
  const log = options.logger ?? noopLogger;
  return {
    // Arithmetic
    add: pure((a: number, b: number) => finiteMathResult("add", a + b)),
    sub: pure((a: number, b: number) => finiteMathResult("sub", a - b)),
    mul: pure((a: number, b: number) => finiteMathResult("mul", a * b)),
    div: pure((a: number, b: number) => {
      if (b === 0) throw new Error("div: division by zero");
      return finiteMathResult("div", a / b);
    }),
    mod: pure((a: number, b: number) => {
      if (b === 0) throw new Error("mod: division by zero");
      return finiteMathResult("mod", a % b);
    }),
    abs: pure((a: number) => finiteMathResult("abs", Math.abs(a))),
    neg: pure((a: number) => finiteMathResult("neg", -a)),
    floor: pure((a: number) => finiteMathResult("floor", Math.floor(a))),
    ceil: pure((a: number) => finiteMathResult("ceil", Math.ceil(a))),
    round: pure((a: number) => finiteMathResult("round", Math.round(a))),
    max: builtin((args, _call, _functions, meter) => {
      const arr = args[0];
      if (!Array.isArray(arr)) throw new Error("max: argument must be an array");
      if (arr.length === 0) throw new Error("max: argument must not be empty");
      meter.charge(arr.length);
      let result = -Infinity;
      for (const value of arr) {
        if (typeof value !== "number") throw new Error("max: array elements must be numbers");
        if (value > result) result = value;
      }
      return finiteMathResult("max", result);
    }, 1),
    min: builtin((args, _call, _functions, meter) => {
      const arr = args[0];
      if (!Array.isArray(arr)) throw new Error("min: argument must be an array");
      if (arr.length === 0) throw new Error("min: argument must not be empty");
      meter.charge(arr.length);
      let result = Infinity;
      for (const value of arr) {
        if (typeof value !== "number") throw new Error("min: array elements must be numbers");
        if (value < result) result = value;
      }
      return finiteMathResult("min", result);
    }, 1),
    sum: builtin((args, _call, _functions, meter) => {
      const arr = args[0];
      if (!Array.isArray(arr)) throw new Error("sum: argument must be an array");
      meter.charge(arr.length);
      let total = 0;
      for (const value of arr) {
        if (typeof value !== "number") throw new Error("sum: array elements must be numbers");
        total += value;
      }
      return finiteMathResult("sum", total);
    }, 1),
    sqrt: pure((value: number) => finiteMathResult("sqrt", Math.sqrt(value))),
    pow: pure((base: number, exponent: number) =>
      finiteMathResult("pow", Math.pow(base, exponent)),
    ),

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
    and: pure((a: boolean, b: boolean) => {
      if (typeof a !== "boolean" || typeof b !== "boolean")
        throw new Error("and: arguments must be booleans");
      return a && b;
    }),
    or: pure((a: boolean, b: boolean) => {
      if (typeof a !== "boolean" || typeof b !== "boolean")
        throw new Error("or: arguments must be booleans");
      return a || b;
    }),

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
      if (typeof a === "number") return finiteMathResult("num", a);
      if (typeof a === "boolean") return a ? 1 : 0;
      if (a === null) return 0;
      if (typeof a === "string") {
        const n = Number(a);
        if (!Number.isFinite(n)) throw new Error(`num: cannot parse "${a}" as a finite number`);
        return n;
      }
      throw new Error(`num: cannot convert ${typeof a} to number`);
    }),

    // Arrays
    length: pure((value: any[] | string) => {
      if (!Array.isArray(value) && typeof value !== "string")
        throw new Error("length: argument must be an array or string");
      return value.length;
    }),
    head: pure((arr: any[]) => {
      if (!Array.isArray(arr)) throw new Error("head: argument must be an array");
      return arr[0] ?? null;
    }),
    last: pure((arr: any[]) => {
      if (!Array.isArray(arr)) throw new Error("last: argument must be an array");
      return arr[arr.length - 1] ?? null;
    }),
    tail: pure((arr: any[]) => {
      if (!Array.isArray(arr)) throw new Error("tail: argument must be an array");
      return arr.slice(1);
    }),
    concat: pure((...arrays: any[][]) => {
      const result: any[] = [];
      for (const arr of arrays) {
        if (!Array.isArray(arr)) throw new Error("concat: arguments must be arrays");
        for (const item of arr) result.push(item);
      }
      return result;
    }),
    range: builtin((args, _call, _functions, meter) => {
      const n = args[0];
      if (typeof n !== "number" || !Number.isInteger(n))
        throw new Error("range: argument must be an integer");
      const len = Math.max(0, n);
      meter.guardSize(len);
      return Array.from({ length: len }, (_, i) => i);
    }, 1),
    slice: pure((value: any[] | string, start: number, end?: number) => {
      if (!Array.isArray(value) && typeof value !== "string")
        throw new Error("slice: first argument must be an array or string");
      if (!Number.isInteger(start)) throw new Error("slice: second argument must be an integer");
      if (end !== undefined && !Number.isInteger(end))
        throw new Error("slice: third argument must be an integer");
      return end === undefined ? value.slice(start) : value.slice(start, end);
    }),
    reverse: pure((arr: any[]) => {
      if (!Array.isArray(arr)) throw new Error("reverse: argument must be an array");
      return [...arr].reverse();
    }),
    take: pure((arr: any[], count: number) => {
      if (!Array.isArray(arr)) throw new Error("take: first argument must be an array");
      if (!Number.isInteger(count)) throw new Error("take: second argument must be an integer");
      return arr.slice(0, Math.max(0, count));
    }),
    drop: pure((arr: any[], count: number) => {
      if (!Array.isArray(arr)) throw new Error("drop: first argument must be an array");
      if (!Number.isInteger(count)) throw new Error("drop: second argument must be an integer");
      return arr.slice(Math.max(0, count));
    }),
    zip: pure((left: any[], right: any[]) => {
      if (!Array.isArray(left) || !Array.isArray(right))
        throw new Error("zip: arguments must be arrays");
      const length = Math.min(left.length, right.length);
      return Array.from({ length }, (_, i) => [left[i], right[i]]);
    }),
    unique: builtin((args, _call, _functions, meter) => {
      const arr = args[0];
      if (!Array.isArray(arr)) throw new Error("unique: argument must be an array");
      meter.charge(arr.length);
      const result: JSONType[] = [];
      for (const value of arr) {
        let seen = false;
        for (const existing of result) {
          meter.charge(1);
          if (jsonEqual(value, existing)) {
            seen = true;
            break;
          }
        }
        if (!seen) result.push(value);
      }
      return result;
    }, 1),
    repeat: builtin((args, _call, _functions, meter) => {
      const [value, count] = args;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
        throw new Error("repeat: count must be a non-negative integer");
      const repetitions = count;
      if (typeof value === "string") {
        const size = value.length * repetitions;
        meter.guardSize(size);
        return value.repeat(repetitions);
      }
      if (Array.isArray(value)) {
        const size = value.length * repetitions;
        meter.guardSize(size);
        const result: JSONType[] = [];
        for (let i = 0; i < repetitions; i++) {
          for (const item of value) result.push(item);
        }
        return result;
      }
      throw new Error("repeat: first argument must be a string or array");
    }, 2),
    // Membership uses the same structural equality as `eq` for array elements;
    // on strings these stay substring/char-index checks.
    includes: pure((arr: any[] | string, value: any) =>
      typeof arr === "string" ? arr.includes(value) : arr.some((el) => jsonEqual(el, value)),
    ),
    indexOf: pure((arr: any[] | string, value: any) => {
      const i =
        typeof arr === "string" ? arr.indexOf(value) : arr.findIndex((el) => jsonEqual(el, value));
      return i === -1 ? null : i;
    }),
    flatten: pure((arr: any[]) => {
      if (!Array.isArray(arr)) throw new Error("flatten: argument must be an array");
      return arr.flat();
    }),
    setAt: pure((arr: any[], idx: number, value: any) => {
      if (!Array.isArray(arr)) throw new Error("setAt: first argument must be an array");
      if (!Number.isInteger(idx)) throw new Error("setAt: second argument must be an integer");
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
    startsWith: pure((s: string, prefix: string) => s.startsWith(prefix)),
    endsWith: pure((s: string, suffix: string) => s.endsWith(suffix)),
    replace: pure((s: string, search: string, replacement: string) => {
      if (search.length === 0) throw new Error("replace: search string must not be empty");
      return s.replaceAll(search, replacement);
    }),
    padStart: pure((s: string, targetLength: number, fill = " ") => {
      if (!Number.isInteger(targetLength) || targetLength < 0)
        throw new Error("padStart: target length must be a non-negative integer");
      if (fill.length === 0) return s;
      const value = Array.from(s);
      const needed = targetLength - value.length;
      if (needed <= 0) return s;
      const fillChars = Array.from(fill);
      const padding = Array.from(
        { length: needed },
        (_, i) => fillChars[i % fillChars.length],
      ).join("");
      return padding + s;
    }),

    // Object utilities
    keys: pure((obj: Record<string, any>) => {
      if (!isPlainObject(obj)) throw new Error("keys: argument must be an object");
      return Object.keys(obj);
    }),
    values: pure((obj: Record<string, any>) => {
      if (!isPlainObject(obj)) throw new Error("values: argument must be an object");
      return Object.values(obj);
    }),
    entries: pure((obj: Record<string, any>) => {
      if (!isPlainObject(obj)) throw new Error("entries: argument must be an object");
      return Object.entries(obj);
    }),
    fromEntries: pure((pairs: [string, any][]) => Object.fromEntries(pairs)),
    merge: pure((a: Record<string, any>, b: Record<string, any>) => {
      if (!isPlainObject(a) || !isPlainObject(b))
        throw new Error("merge: arguments must be objects");
      return { ...a, ...b };
    }),
    hasKey: pure((obj: Record<string, any>, key: string) => {
      if (!isPlainObject(obj)) throw new Error("hasKey: first argument must be an object");
      return Object.hasOwn(obj, key);
    }),
    isObject: pure((a: any) => isPlainObject(a)),
    pick: pure((obj: Record<string, any>, ks: string[]) => {
      if (!isPlainObject(obj)) throw new Error("pick: first argument must be an object");
      const result: Record<string, any> = {};
      for (const k of ks) if (k in obj) result[k] = obj[k];
      return result;
    }),
    omit: pure((obj: Record<string, any>, ks: string[]) => {
      if (!isPlainObject(obj)) throw new Error("omit: first argument must be an object");
      const exclude = new Set(ks);
      const result: Record<string, any> = {};
      for (const k of Object.keys(obj)) if (!exclude.has(k)) result[k] = obj[k];
      return result;
    }),

    // Higher-order builtins (interpreter-aware — can invoke JSON callbacks).
    // Each charges fuel proportional to the number of elements it iterates over;
    // the per-callback cost is charged separately by the interpreter's call
    // chokepoint. See docs/execution-limits.md.
    map: arrayMapBuiltin("map", false),
    mapIndexed: arrayMapBuiltin("mapIndexed", true),
    filter: arrayFilterBuiltin("filter", false),
    filterIndexed: arrayFilterBuiltin("filterIndexed", true),
    reduce: arrayReduceBuiltin("reduce", false),
    reduceIndexed: arrayReduceBuiltin("reduceIndexed", true),
    find: arrayFindBuiltin("find", false, false),
    findIndexed: arrayFindBuiltin("findIndexed", true, false),
    findIndex: arrayFindBuiltin("findIndex", false, true),
    findIndexIndexed: arrayFindBuiltin("findIndexIndexed", true, true),
    some: arrayQuantifierBuiltin("some", false, "some"),
    someIndexed: arrayQuantifierBuiltin("someIndexed", true, "some"),
    every: arrayQuantifierBuiltin("every", false, "every"),
    everyIndexed: arrayQuantifierBuiltin("everyIndexed", true, "every"),
    count: arrayQuantifierBuiltin("count", false, "count"),
    countIndexed: arrayQuantifierBuiltin("countIndexed", true, "count"),
    sort: builtin((args, call, _functions, meter) => {
      if (args.length === 1) {
        const arr = args[0];
        if (!Array.isArray(arr)) throw new Error("sort: argument must be an array");
        meter.charge(arr.length);
        const kind = arr.length === 0 ? undefined : typeof arr[0];
        if (
          (kind !== undefined && kind !== "number" && kind !== "string") ||
          arr.some((value) => typeof value !== kind)
        ) {
          throw new Error("sort: default sort requires all elements to be numbers or all strings");
        }
        if (kind === "string") {
          return [...arr].sort((a, b) => compareStrings(a as string, b as string, meter));
        }
        return [...arr].sort((a, b) => {
          meter.charge(1);
          return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
        });
      }
      const [comparator, arr] = args;
      if (!Array.isArray(arr)) throw new Error("sort: second argument must be an array");
      meter.charge(arr.length);
      return [...arr].sort((a, b) => {
        const compared = call(comparator!, [a, b]);
        if (typeof compared !== "number" || !Number.isFinite(compared))
          throw new Error("sort: comparator must return a finite number");
        return compared;
      });
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
    flatMap: arrayFlatMapBuiltin("flatMap", false),
    flatMapIndexed: arrayFlatMapBuiltin("flatMapIndexed", true),
    groupBy: arrayGroupByBuiltin("groupBy", false),
    groupByIndexed: arrayGroupByBuiltin("groupByIndexed", true),
    sortBy: arraySortByBuiltin("sortBy", false),
    sortByIndexed: arraySortByBuiltin("sortByIndexed", true),
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
    reTest: builtin((args, _call, _functions, meter) => {
      const [pattern, str] = args;
      if (typeof pattern !== "string" || typeof str !== "string")
        throw new Error("reTest: arguments must be strings");
      meter.charge(str.length);
      return parsePattern(pattern).test(str);
    }, 2),
    reMatch: builtin((args, _call, _functions, meter) => {
      const [pattern, str] = args;
      if (typeof pattern !== "string" || typeof str !== "string")
        throw new Error("reMatch: arguments must be strings");
      meter.charge(str.length);
      const re = parsePattern(pattern);
      const m = re.exec(str);
      if (!m) return null;
      return buildMatchResult(m);
    }, 2),
    reMatchAll: builtin((args, _call, _functions, meter) => {
      const [pattern, str] = args;
      if (typeof pattern !== "string" || typeof str !== "string")
        throw new Error("reMatchAll: arguments must be strings");
      meter.charge(str.length);
      const re = parsePattern(pattern);
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      const results: Record<string, any>[] = [];
      let m: RegExpExecArray | null;
      while ((m = global.exec(str)) !== null) {
        meter.charge(1);
        results.push(buildMatchResult(m));
        if (m[0]!.length === 0) global.lastIndex++;
      }
      return results;
    }, 2),
    reReplace: builtin((args, _call, _functions, meter) => {
      const [pattern, replacement, str] = args;
      if (
        typeof pattern !== "string" ||
        typeof replacement !== "string" ||
        typeof str !== "string"
      ) {
        throw new Error("reReplace: arguments must be strings");
      }
      meter.charge(str.length);
      const re = parsePattern(pattern);
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      return str.replace(global, replacement);
    }, 3),
    reSplit: builtin((args, _call, _functions, meter) => {
      const [pattern, str] = args;
      if (typeof pattern !== "string" || typeof str !== "string")
        throw new Error("reSplit: arguments must be strings");
      meter.charge(str.length);
      return str.split(parsePattern(pattern));
    }, 2),
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
        if (typeof replaced !== "string")
          throw new Error("reReplaceWith: callback must return a string");
        parts.push(replaced);
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
      (args, call, _functions, meter, runtime) =>
        runHandle(args[0]!, args[1]!, call, meter, args[2], runtime.defs),
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
