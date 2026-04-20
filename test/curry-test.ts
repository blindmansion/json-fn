// ---------------------------------------------------------------------------
// curry-test.ts — Can the DSL express a working curry function?
//
// This file tests each capability that a curry implementation requires,
// one at a time, to find exactly where the DSL works and where it breaks.
// ---------------------------------------------------------------------------

import {
  callFunction,
  FunctionSource,
  type NamedFunctionDeclaration,
  type JSONType,
} from "../src/evaluate";

const functions: Record<string, NamedFunctionDeclaration> = {};

function ext(name: string, fn: Function): NamedFunctionDeclaration {
  return { source: FunctionSource.External, name, fn };
}

function json(
  name: string,
  fn: { [key: string]: JSONType; $return: JSONType }
): NamedFunctionDeclaration {
  return { source: FunctionSource.JSON, name, fn };
}

const getFunction = (name: string) => functions[name];

function run(label: string, body: any, args: JSONType[] = []): JSONType | null {
  try {
    const result = callFunction(body, args, { getFunction });
    console.log(`  ✓ ${label}  →  ${JSON.stringify(result)}`);
    return result;
  } catch (e: any) {
    console.log(`  ✗ ${label}  →  ERROR: ${e.message.split("\n")[0]}`);
    return null;
  }
}

// Register primitives
Object.assign(functions, {
  add: ext("add", (a: number, b: number) => a + b),
  sub: ext("sub", (a: number, b: number) => a - b),
  mul: ext("mul", (a: number, b: number) => a * b),
  eq: ext("eq", (a: any, b: any) => a === b),
  gte: ext("gte", (a: number, b: number) => a >= b),
  lte: ext("lte", (a: number, b: number) => a <= b),
  length: ext("length", (arr: any[]) => arr.length),
  concat: ext("concat", (a: any[], b: any[]) => [...a, ...b]),
});


// ===========================================================================
// TEST 1: Returning a function body as a value (closures)
//
// Curry must return a function, not a final value. The DSL handles this
// through FunctionBody expressions — when a { ..., $return } object is
// encountered as a value (not called), replaceVars captures any in-scope
// variables into it, forming a closure.
// ===========================================================================
console.log("\n── Test 1: Return a function body as a value ──\n");

// A function that returns an "adder" function with `x` captured.
// makeAdder(10) should return { $return: { $fn: "add", $args: [10, { $args: 0 }] } }
run("makeAdder(10)", {
  x: { $args: 0 },
  $return: {
    $return: { $fn: "add", $args: [{ $var: "x" }, { $args: 0 }] },
  },
}, [10]);


// ===========================================================================
// TEST 2: Calling a returned function body
//
// Can we take the function body returned by Test 1 and call it?
// This requires { $fn: <function-body>, $args: [...] } to work.
// ===========================================================================
console.log("\n── Test 2: Call a returned function body ──\n");

// Two-step: makeAdder(10) then call the result with (5)
// Expected: 15
run("makeAdder(10)(5) — via nested inline call", {
  adder: {
    $fn: {
      x: { $args: 0 },
      $return: {
        $return: { $fn: "add", $args: [{ $var: "x" }, { $args: 0 }] },
      },
    },
    $args: [10],
  },
  $return: {
    $fn: { $var: "adder" },
    $args: [5],
  },
});


// ===========================================================================
// TEST 3: Variadic arguments — { $args: [] }
//
// The curryJson sketch uses { $args: [] } to mean "all arguments." In the
// interpreter, $args can be a number (single arg) or a two-element array
// (slice). An empty array would do args.slice(undefined, undefined), which
// in JS returns a copy of the full array. Let's see if it actually works.
// ===========================================================================
console.log("\n── Test 3: Variadic arguments with { $args: [] } ──\n");

run("capture all args via { $args: [] }", {
  allArgs: { $args: [] },
  $return: { $var: "allArgs" },
}, [10, 20, 30]);


// ===========================================================================
// TEST 4: Dynamic function dispatch — { $fn: { $var: "name" } }
//
// Curry needs to call a function that was passed in as an argument.
// The DSL supports this: $fn can be any expression that evaluates to a
// string (named function) or a function body.
// ===========================================================================
console.log("\n── Test 4: Dynamic function dispatch via variable ──\n");

// Pass "add" as an argument, then call it dynamically.
run("call a function by name from args", {
  fnName: { $args: 0 },
  $return: {
    $fn: { $var: "fnName" },
    $args: [3, 4],
  },
}, ["add"]);

// Pass "mul" as an argument.
run("call 'mul' by name from args", {
  fnName: { $args: 0 },
  $return: {
    $fn: { $var: "fnName" },
    $args: [3, 4],
  },
}, ["mul"]);


// ===========================================================================
// TEST 5: Closure capture — returning a function that closes over a variable
// from an outer scope, then calling it
//
// This is the crux of curry: the returned function must remember the
// accumulated arguments from previous calls.
// ===========================================================================
console.log("\n── Test 5: Closure capture ──\n");

// partialAdd captures `a` and returns a function waiting for `b`.
// partialAdd(10) → fn(b) → add(10, b)
// Then we call that with (7) → 17
functions.partialAdd = json("partialAdd", {
  a: { $args: 0 },
  $return: {
    $return: { $fn: "add", $args: [{ $var: "a" }, { $args: 0 }] },
  },
});

run("partialAdd(10) returns a function", {
  $return: { $fn: "partialAdd", $args: [10] },
});

run("call partialAdd(10)(7)", {
  partial: { $fn: "partialAdd", $args: [10] },
  $return: {
    $fn: { $var: "partial" },
    $args: [7],
  },
});


// ===========================================================================
// TEST 6: Accumulating arguments across calls
//
// Curry accumulates args: first call gets some, second call gets more,
// they get concatenated. Test concat + closure together.
// ===========================================================================
console.log("\n── Test 6: Accumulate arguments across calls ──\n");

// accum(initialArgs) → fn(moreArgs) → concat(initialArgs, moreArgs)
functions.accum = json("accum", {
  initial: { $args: [] },
  $return: {
    $return: {
      $fn: "concat",
      $args: [{ $var: "initial" }, { $args: [] }],
    },
  },
});

run("accum([1,2])([3,4])", {
  step1: { $fn: "accum", $args: [1, 2] },
  $return: {
    $fn: { $var: "step1" },
    $args: [3, 4],
  },
});


// ===========================================================================
// TEST 7: Arity check — enough args to apply?
//
// Curry needs to compare accumulated arg count against target arity.
// We don't have a built-in "arity" function, but we can pass arity as
// a known value and test the comparison logic.
// ===========================================================================
console.log("\n── Test 7: Arity check ──\n");

run("length([1,2,3]) >= 3", {
  args: [1, 2, 3],
  numArgs: { $fn: "length", $args: [{ $var: "args" }] },
  enough: { $fn: "gte", $args: [{ $var: "numArgs" }, 3] },
  $return: { $var: "enough" },
}); // true

run("length([1,2]) >= 3", {
  args: [1, 2],
  numArgs: { $fn: "length", $args: [{ $var: "args" }] },
  enough: { $fn: "gte", $args: [{ $var: "numArgs" }, 3] },
  $return: { $var: "enough" },
}); // false


// ===========================================================================
// TEST 8: Putting it together — a manual two-step curry of add(a, b)
//
// This manually implements what curry(add) would produce:
// curried(a)(b) → add(a, b)
// No generic curry yet, just the specific shape.
// ===========================================================================
console.log("\n── Test 8: Manual curry of add ──\n");

functions.curriedAdd = json("curriedAdd", {
  a: { $args: 0 },
  $return: {
    $return: {
      $fn: "add",
      $args: [{ $var: "a" }, { $args: 0 }],
    },
  },
});

run("curriedAdd(10)(32)", {
  step1: { $fn: "curriedAdd", $args: [10] },
  $return: {
    $fn: { $var: "step1" },
    $args: [32],
  },
}); // 42


// ===========================================================================
// TEST 9: Generic curry — the real thing
//
// Can we define a generic curry(targetFnName, arity) that works for any
// function? This is a simplified version of the curryJson sketch that:
//   - Takes a function name and its arity as arguments (avoids needing
//     a built-in "arity" introspection function)
//   - Returns a function that accumulates args across calls
//   - When enough args are collected, calls the target function
//
// Key question: can a returned function body close over both `targetFn`
// and `arity` and recursively call a helper to keep accumulating?
// ===========================================================================
console.log("\n── Test 9: Generic curry ──\n");

// Helper: curryApply(targetFn, arity, accumulatedArgs, newArgs)
// Concatenates args, checks if we have enough, either applies or returns
// another collector function.
functions.curryApply = json("curryApply", {
  targetFn: { $args: 0 },
  arity: { $args: 1 },
  accumulated: { $args: 2 },
  newArgs: { $args: 3 },
  allArgs: { $fn: "concat", $args: [{ $var: "accumulated" }, { $var: "newArgs" }] },
  numArgs: { $fn: "length", $args: [{ $var: "allArgs" }] },
  enough: { $fn: "gte", $args: [{ $var: "numArgs" }, { $var: "arity" }] },
  $return: {
    $if: { $var: "enough" },
    $then: {
      $fn: { $var: "targetFn" },
      $args: { $var: "allArgs" },
    },
    $else: {
      // Return a new function that, when called, recurses with more args
      $return: {
        $fn: "curryApply",
        $args: [
          { $var: "targetFn" },
          { $var: "arity" },
          { $var: "allArgs" },
          { $args: [] },
        ],
      },
    },
  },
});

// curry(targetFnName, arity) → returns a collector function
functions.curry = json("curry", {
  targetFn: { $args: 0 },
  arity: { $args: 1 },
  $return: {
    // Return a function that starts accumulation with empty list
    $return: {
      $fn: "curryApply",
      $args: [{ $var: "targetFn" }, { $var: "arity" }, [], { $args: [] }],
    },
  },
});

// curry("add", 2) should return a function.
// Calling it with (10) should return another function.
// Calling that with (32) should return 42.
const curriedAddFn = run("curry('add', 2) — returns a function", {
  $return: { $fn: "curry", $args: ["add", 2] },
});

if (curriedAddFn) {
  // Call the curried function with one arg
  run("curriedAdd(10) — returns another function", {
    curriedAdd: { $fn: "curry", $args: ["add", 2] },
    $return: {
      $fn: { $var: "curriedAdd" },
      $args: [10],
    },
  });

  // Full chain: curry("add", 2)(10)(32)
  run("curry('add', 2)(10)(32) — full curried call", {
    step1: { $fn: "curry", $args: ["add", 2] },
    step2: {
      $fn: { $var: "step1" },
      $args: [10],
    },
    $return: {
      $fn: { $var: "step2" },
      $args: [32],
    },
  });
}

// Also test: supply all args at once
run("curry('add', 2)(10, 32) — all args at once", {
  curriedAdd: { $fn: "curry", $args: ["add", 2] },
  $return: {
    $fn: { $var: "curriedAdd" },
    $args: [10, 32],
  },
});

// Test with a 3-argument function
functions.add3 = ext("add3", (a: number, b: number, c: number) => a + b + c);

run("curry('add3', 3)(1)(2)(3)", {
  step1: { $fn: "curry", $args: ["add3", 3] },
  step2: { $fn: { $var: "step1" }, $args: [1] },
  step3: { $fn: { $var: "step2" }, $args: [2] },
  $return: { $fn: { $var: "step3" }, $args: [3] },
});

run("curry('add3', 3)(1, 2)(3)", {
  step1: { $fn: "curry", $args: ["add3", 3] },
  step2: { $fn: { $var: "step1" }, $args: [1, 2] },
  $return: { $fn: { $var: "step2" }, $args: [3] },
});


// ===========================================================================
// SUMMARY
// ===========================================================================
console.log("\n══════════════════════════════════════════════════════════");
console.log("  RESULTS SUMMARY");
console.log("══════════════════════════════════════════════════════════\n");
console.log(`
Tests 1-8 check the individual building blocks curry needs:
  1. Returning function bodies as values
  2. Calling returned function bodies
  3. Variadic arguments via { $args: [] }
  4. Dynamic function dispatch via variable
  5. Closure capture (returned fn remembers outer scope)
  6. Accumulating arguments across calls
  7. Arity comparison
  8. Manual (non-generic) curried add

Test 9 attempts a fully generic curry implementation.

See output above for ✓ (pass) vs ✗ (fail) on each.
`);
