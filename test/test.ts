import {
  callFunction,
  FunctionSource,
  type NamedFunctionDeclaration,
  type BuiltinFunction,
  type JSONType,
} from "../src/evaluate";

// ---------------------------------------------------------------------------
// Helper: run a JSON function body and print the result
// ---------------------------------------------------------------------------
function run(label: string, body: JSONType, args: JSONType[] = []) {
  const result = callFunction(body as any, args, { getFunction });
  console.log(`${label}  →  ${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------------
// Function registry — a mix of native JS primitives and JSON-defined functions
// ---------------------------------------------------------------------------
const functions: Record<string, NamedFunctionDeclaration> = {
  // Arithmetic
  add: ext("add", (a: number, b: number) => a + b),
  sub: ext("sub", (a: number, b: number) => a - b),
  mul: ext("mul", (a: number, b: number) => a * b),
  mod: ext("mod", (a: number, b: number) => a % b),

  // Comparison
  eq: ext("eq", (a: any, b: any) => a === b),
  gt: ext("gt", (a: number, b: number) => a > b),
  gte: ext("gte", (a: number, b: number) => a >= b),
  lt: ext("lt", (a: number, b: number) => a < b),
  lte: ext("lte", (a: number, b: number) => a <= b),

  // Logic
  not: ext("not", (a: boolean) => !a),
  and: ext("and", (a: boolean, b: boolean) => a && b),
  or: ext("or", (a: boolean, b: boolean) => a || b),

  // Arrays
  length: ext("length", (arr: any[]) => arr.length),
  head: ext("head", (arr: any[]) => arr[0]),
  tail: ext("tail", (arr: any[]) => arr.slice(1)),
  concat: ext("concat", (a: any[], b: any[]) => [...a, ...b]),

  // Builtins (interpreter-aware — can invoke JSON callbacks)
  map: builtin("map", (args, ctx, callFn) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error("map: second argument must be an array");
    return arr.map((item, i) => callFn(callback as any, [item, i], ctx));
  }),
  filter: builtin("filter", (args, ctx, callFn) => {
    const [callback, arr] = args;
    if (!Array.isArray(arr)) throw new Error("filter: second argument must be an array");
    return arr.filter((item, i) => callFn(callback as any, [item, i], ctx));
  }),
  reduce: builtin("reduce", (args, ctx, callFn) => {
    const [callback, init, arr] = args as [JSONType, JSONType, JSONType];
    if (!Array.isArray(arr)) throw new Error("reduce: third argument must be an array");
    return arr.reduce(
      (acc: JSONType, item, i) => callFn(callback as any, [acc, item, i], ctx),
      init
    );
  }),

  // Strings
  upper: ext("upper", (s: string) => s.toUpperCase()),
  strcat: ext("strcat", (a: string, b: string) => a + b),
};

function ext(name: string, fn: Function): NamedFunctionDeclaration {
  return { source: FunctionSource.External, name, fn };
}

function builtin(name: string, fn: BuiltinFunction): NamedFunctionDeclaration {
  return { source: FunctionSource.Builtin, name, fn };
}

function json(
  name: string,
  fn: { [key: string]: JSONType; $return: JSONType }
): NamedFunctionDeclaration {
  return { source: FunctionSource.JSON, name, fn };
}

const getFunction = (name: string) => functions[name];

// ===========================================================================
//  DEMOS
// ===========================================================================

console.log("=== 1. Primitives (literals evaluate to themselves) ===\n");

// Strings, numbers, booleans, null, arrays, and plain objects are all
// valid expressions that evaluate to themselves.
run("string", { $return: "hello" });
run("number", { $return: 42 });
run("boolean", { $return: true });
run("null", { $return: null });
run("array", { $return: [1, 2, 3] });
run("object", { $return: { x: 1, y: 2 } });

// ---------------------------------------------------------------------------
console.log("\n=== 2. Calling external (JS) functions with $fn/$args ===\n");

// { $fn: "<name>", $args: [...] }  calls a registered function.
run("add(3, 4)", {
  $return: { $fn: "add", $args: [3, 4] },
});

run("upper('hello')", {
  $return: { $fn: "upper", $args: ["hello"] },
});

// Nested calls — the result of one call feeds into another.
// mul(add(2, 3), sub(10, 4))  →  5 * 6  →  30
run("mul(add(2,3), sub(10,4))", {
  $return: {
    $fn: "mul",
    $args: [
      { $fn: "add", $args: [2, 3] },
      { $fn: "sub", $args: [10, 4] },
    ],
  },
});

// ---------------------------------------------------------------------------
console.log("\n=== 3. Positional arguments with $args ===\n");

// Inside a function body, { $args: N } refers to the Nth argument (0-based).
// { $args: [start, end] } slices the argument list.

// A function that adds its two arguments:
const addArgs = {
  $return: { $fn: "add", $args: [{ $args: 0 }, { $args: 1 }] },
};
run("addArgs(10, 20)", addArgs, [10, 20]);

// ---------------------------------------------------------------------------
console.log("\n=== 4. Local variables with $var ===\n");

// Keys in a function body (other than $return) define local variables.
// They are lazily evaluated and can reference each other.
run("local vars", {
  a: 5,
  b: 10,
  sum: { $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] },
  doubled: { $fn: "mul", $args: [{ $var: "sum" }, 2] },
  $return: { $var: "doubled" }, // (5 + 10) * 2  →  30
});

// Variables can also reference arguments:
run("vars + args", {
  x: { $args: 0 },
  y: { $args: 1 },
  product: { $fn: "mul", $args: [{ $var: "x" }, { $var: "y" }] },
  $return: { $var: "product" },
}, [7, 8]); // 7 * 8  →  56

// ---------------------------------------------------------------------------
console.log("\n=== 5. Conditionals with $if/$then/$else ===\n");

// { $if: <expr>, $then: <expr>, $else: <expr> }
// Evaluates $if; if truthy, evaluates $then, otherwise $else.
run("if true", {
  $return: {
    $if: { $fn: "gt", $args: [10, 5] },
    $then: "ten is greater",
    $else: "five is greater",
  },
});

run("if false", {
  $return: {
    $if: { $fn: "gt", $args: [3, 5] },
    $then: "three is greater",
    $else: "five is greater",
  },
});

// ---------------------------------------------------------------------------
console.log("\n=== 6. JSON-defined (named) functions ===\n");

// Register a JSON-defined function that doubles its argument.
functions.double = json("double", {
  $return: { $fn: "mul", $args: [{ $args: 0 }, 2] },
});

// Register "isEven" which uses double, mod, and eq.
functions.isEven = json("isEven", {
  n: { $args: 0 },
  remainder: { $fn: "mod", $args: [{ $var: "n" }, 2] },
  $return: { $fn: "eq", $args: [{ $var: "remainder" }, 0] },
});

run("double(21)", { $return: { $fn: "double", $args: [21] } });
run("isEven(4)", { $return: { $fn: "isEven", $args: [4] } });
run("isEven(7)", { $return: { $fn: "isEven", $args: [7] } });

// ---------------------------------------------------------------------------
console.log("\n=== 7. Recursion ===\n");

// Factorial: fact(n) = if n <= 1 then 1 else n * fact(n - 1)
functions.fact = json("fact", {
  n: { $args: 0 },
  $return: {
    $if: { $fn: "lte", $args: [{ $var: "n" }, 1] },
    $then: 1,
    $else: {
      $fn: "mul",
      $args: [
        { $var: "n" },
        { $fn: "fact", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 1] }] },
      ],
    },
  },
});

run("fact(0)", { $return: { $fn: "fact", $args: [0] } });
run("fact(1)", { $return: { $fn: "fact", $args: [1] } });
run("fact(5)", { $return: { $fn: "fact", $args: [5] } }); // 120
run("fact(10)", { $return: { $fn: "fact", $args: [10] } }); // 3628800

// Fibonacci (same as original demo)
functions.fib = json("fib", {
  n: { $args: 0 },
  $return: {
    $if: { $fn: "lte", $args: [{ $var: "n" }, 1] },
    $then: { $var: "n" },
    $else: {
      $fn: "add",
      $args: [
        { $fn: "fib", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 1] }] },
        { $fn: "fib", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 2] }] },
      ],
    },
  },
});

run("fib(0)", { $return: { $fn: "fib", $args: [0] } });
run("fib(1)", { $return: { $fn: "fib", $args: [1] } });
run("fib(10)", { $return: { $fn: "fib", $args: [10] } }); // 55

// ---------------------------------------------------------------------------
console.log("\n=== 8. Inline (anonymous) functions ===\n");

// A function body can be used directly as the $fn value instead of a
// named reference string. This is the equivalent of an IIFE / lambda.

// Inline "square" — defines and immediately calls a one-off function.
run("inline square(5)", {
  $return: {
    $fn: {
      x: { $args: 0 },
      $return: { $fn: "mul", $args: [{ $var: "x" }, { $var: "x" }] },
    },
    $args: [5],
  },
}); // 25

// Nested inline functions — the outer one sums its args, then passes the
// result into an inner inline function that squares it.
// sumThenSquare(3, 4)  →  (3+4)²  →  49
run("inline sumThenSquare(3, 4)", {
  $return: {
    $fn: {
      a: { $args: 0 },
      b: { $args: 1 },
      $return: {
        $fn: {
          sum: { $args: 0 },
          $return: { $fn: "mul", $args: [{ $var: "sum" }, { $var: "sum" }] },
        },
        $args: [{ $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] }],
      },
    },
    $args: [3, 4],
  },
}); // 49

// ---------------------------------------------------------------------------
console.log("\n=== 9. Composing everything together ===\n");

// "Is the factorial of N even?"
// Combines named JSON functions, variables, and conditionals.
run("isEven(fact(6))", {
  result: { $fn: "fact", $args: [6] }, // 720
  check: { $fn: "isEven", $args: [{ $var: "result" }] },
  $return: {
    $if: { $var: "check" },
    $then: { $fn: "strcat", $args: ["720 is ", "even"] },
    $else: { $fn: "strcat", $args: ["720 is ", "odd"] },
  },
});

// Build a greeting from parts using variables and string concatenation.
run("greeting", {
  first: { $args: 0 },
  last: { $args: 1 },
  full: { $fn: "strcat", $args: [{ $var: "first" }, { $fn: "strcat", $args: [" ", { $var: "last" }] }] },
  $return: { $fn: "strcat", $args: ["Hello, ", { $var: "full" }] },
}, ["Ada", "Lovelace"]); // "Hello, Ada Lovelace"

// ---------------------------------------------------------------------------
console.log("\n=== 10. Property access with $get/$from ===\n");

// Single key access on an object.
run("get 'name' from object", {
  person: { name: "Ada", age: 36 },
  $return: { $get: "name", $from: { $var: "person" } },
}); // "Ada"

// Numeric index access on an array.
run("get index 1 from array", {
  $return: { $get: 1, $from: [10, 20, 30] },
}); // 20

// Path access — array of keys walks nested structure.
run("get ['address','city'] from nested object", {
  person: { name: "Ada", address: { city: "London", zip: "SW1" } },
  $return: { $get: ["address", "city"], $from: { $var: "person" } },
}); // "London"

// Dynamic key — $get expression is a variable.
run("dynamic key via variable", {
  data: { x: 100, y: 200 },
  field: "y",
  $return: { $get: { $var: "field" }, $from: { $var: "data" } },
}); // 200

// Dynamic key from function result.
run("dynamic key from function call", {
  data: { hello: "world" },
  $return: {
    $get: { $fn: "strcat", $args: ["hel", "lo"] },
    $from: { $var: "data" },
  },
}); // "world"

// Mixed path with array index.
run("path with array index", {
  data: { items: ["a", "b", "c"] },
  $return: { $get: ["items", 2], $from: { $var: "data" } },
}); // "c"

// Missing key returns null.
run("missing key returns null", {
  obj: { a: 1 },
  $return: { $get: "z", $from: { $var: "obj" } },
}); // null

// Missing path segment returns null.
run("missing path segment returns null", {
  obj: { a: { b: 1 } },
  $return: { $get: ["a", "missing", "deep"], $from: { $var: "obj" } },
}); // null

// $get with $from from function call result.
run("$get from function result", {
  $return: {
    $get: 0,
    $from: { $fn: "concat", $args: [[10], [20]] },
  },
}); // 10

// Composed: get a field, then pass it to a function.
run("get field then transform", {
  person: { name: "ada", age: 36 },
  name: { $get: "name", $from: { $var: "person" } },
  $return: { $fn: "upper", $args: [{ $var: "name" }] },
}); // "ADA"

// ---------------------------------------------------------------------------
console.log("\n=== 11. Builtin higher-order functions: map, filter, reduce ===\n");

// map with a named external function
run("map double over array", {
  $return: { $fn: "map", $args: [{ $fn: "double" }, [1, 2, 3, 4]] },
}); // [2, 4, 6, 8]

// map with an inline JSON function body
run("map with inline square fn", {
  $return: {
    $fn: "map",
    $args: [
      { $return: { $fn: "mul", $args: [{ $args: 0 }, { $args: 0 }] } },
      [1, 2, 3, 4, 5],
    ],
  },
}); // [1, 4, 9, 16, 25]

// map with a named JSON function
run("map with named JSON function (isEven)", {
  $return: { $fn: "map", $args: [{ $fn: "isEven" }, [1, 2, 3, 4]] },
}); // [false, true, false, true]

// filter with a named JSON function
run("filter evens", {
  $return: { $fn: "filter", $args: [{ $fn: "isEven" }, [1, 2, 3, 4, 5, 6]] },
}); // [2, 4, 6]

// filter with inline function body
run("filter values > 3", {
  $return: {
    $fn: "filter",
    $args: [
      { $return: { $fn: "gt", $args: [{ $args: 0 }, 3] } },
      [1, 2, 3, 4, 5, 6],
    ],
  },
}); // [4, 5, 6]

// reduce with a named external function
run("reduce add with init 0", {
  $return: { $fn: "reduce", $args: [{ $fn: "add" }, 0, [1, 2, 3, 4]] },
}); // 10

// reduce with inline function body (sum of squares)
run("reduce sum of squares", {
  $return: {
    $fn: "reduce",
    $args: [
      {
        acc: { $args: 0 },
        item: { $args: 1 },
        $return: {
          $fn: "add",
          $args: [
            { $var: "acc" },
            { $fn: "mul", $args: [{ $var: "item" }, { $var: "item" }] },
          ],
        },
      },
      0,
      [1, 2, 3, 4],
    ],
  },
}); // 30

// Chained: filter then map
run("filter evens then double them", {
  evens: { $fn: "filter", $args: [{ $fn: "isEven" }, [1, 2, 3, 4, 5, 6]] },
  $return: { $fn: "map", $args: [{ $fn: "double" }, { $var: "evens" }] },
}); // [4, 8, 12]

// Chained: map then reduce
run("square all then sum", {
  squares: {
    $fn: "map",
    $args: [
      { $return: { $fn: "mul", $args: [{ $args: 0 }, { $args: 0 }] } },
      [1, 2, 3],
    ],
  },
  $return: { $fn: "reduce", $args: [{ $fn: "add" }, 0, { $var: "squares" }] },
}); // 14

// Full pipeline: filter → map → reduce
run("filter evens, double, sum", {
  nums: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  evens: { $fn: "filter", $args: [{ $fn: "isEven" }, { $var: "nums" }] },
  doubled: { $fn: "map", $args: [{ $fn: "double" }, { $var: "evens" }] },
  $return: { $fn: "reduce", $args: [{ $fn: "add" }, 0, { $var: "doubled" }] },
}); // (2+4+6+8+10)*2 = 60

// map using the index argument (second arg to callback)
run("map with index (element + index)", {
  $return: {
    $fn: "map",
    $args: [
      { $return: { $fn: "add", $args: [{ $args: 0 }, { $args: 1 }] } },
      [10, 20, 30],
    ],
  },
}); // [10, 21, 32]

// ---------------------------------------------------------------------------
console.log("\n=== 12. Multi-branch conditionals with $cond ===\n");

// $cond takes an array of [condition, result] pairs. It evaluates conditions
// top-to-bottom and returns the result for the first truthy one.
// Use [true, ...] as a catch-all default.

// Simple multi-way branch — classify a number
functions.classify = json("classify", {
  n: { $args: 0 },
  $return: {
    $cond: [
      [{ $fn: "lt", $args: [{ $var: "n" }, 0] }, "negative"],
      [{ $fn: "eq", $args: [{ $var: "n" }, 0] }, "zero"],
      [true, "positive"],
    ],
  },
});

run("classify(-5)", { $return: { $fn: "classify", $args: [-5] } }); // "negative"
run("classify(0)", { $return: { $fn: "classify", $args: [0] } }); // "zero"
run("classify(42)", { $return: { $fn: "classify", $args: [42] } }); // "positive"

// Replaces a nested if/else chain — FizzBuzz
functions.fizzbuzz = json("fizzbuzz", {
  n: { $args: 0 },
  divBy3: { $fn: "eq", $args: [{ $fn: "mod", $args: [{ $var: "n" }, 3] }, 0] },
  divBy5: { $fn: "eq", $args: [{ $fn: "mod", $args: [{ $var: "n" }, 5] }, 0] },
  divBy15: { $fn: "and", $args: [{ $var: "divBy3" }, { $var: "divBy5" }] },
  $return: {
    $cond: [
      [{ $var: "divBy15" }, "FizzBuzz"],
      [{ $var: "divBy3" }, "Fizz"],
      [{ $var: "divBy5" }, "Buzz"],
      [true, { $var: "n" }],
    ],
  },
});

run("fizzbuzz(15)", { $return: { $fn: "fizzbuzz", $args: [15] } }); // "FizzBuzz"
run("fizzbuzz(9)", { $return: { $fn: "fizzbuzz", $args: [9] } }); // "Fizz"
run("fizzbuzz(10)", { $return: { $fn: "fizzbuzz", $args: [10] } }); // "Buzz"
run("fizzbuzz(7)", { $return: { $fn: "fizzbuzz", $args: [7] } }); // 7

// Inline $cond — no named function needed
run("inline letter grade", {
  score: { $args: 0 },
  $return: {
    $cond: [
      [{ $fn: "gte", $args: [{ $var: "score" }, 90] }, "A"],
      [{ $fn: "gte", $args: [{ $var: "score" }, 80] }, "B"],
      [{ $fn: "gte", $args: [{ $var: "score" }, 70] }, "C"],
      [{ $fn: "gte", $args: [{ $var: "score" }, 60] }, "D"],
      [true, "F"],
    ],
  },
}, [85]); // "B"

// Short-circuit: only the first matching branch's result is evaluated.
// Here only one of the $fn calls actually runs.
run("$cond short-circuits", {
  $return: {
    $cond: [
      [false, { $fn: "add", $args: [1, 2] }],
      [true, "matched second"],
      [true, "never reached"],
    ],
  },
}); // "matched second"

// $cond with a single pair works like a guard
run("$cond single pair (catch-all)", {
  $return: {
    $cond: [
      [true, "always this"],
    ],
  },
}); // "always this"

console.log("\n✓ All demos passed.");
