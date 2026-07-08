import { describe, test, expect } from "bun:test";
import {
  runTask,
  serializeTask,
  hydrateTask,
  requiredCapabilities,
  prepareProgram,
  stepTask,
  createStdlib,
  parseShorthand,
  TaskRaiseError,
  UnhandledEffectError,
  type JSONType,
} from "../src";

// Host-only semantics the pure `spec/cases` corpus can't express: async
// capability round-trips, unhandled effect/raise errors, durable
// suspend→serialize→rehydrate→resume, per-hop abort, and the static
// `requiredCapabilities` admission check.

function moduleOf(src: string): Record<string, JSONType> {
  return parseShorthand(src) as Record<string, JSONType>;
}

describe("runTask: async capability round-trips", () => {
  test("greeter reads then prints, threading effect results", async () => {
    const mod = moduleOf(`{
      greet: () => do {
        name <- perform("readLine", []),
        _ <- perform("print", [\`hi \${name}\`]),
        pure(name)
      }
    }`);
    const printed: string[] = [];
    const result = await runTask(mod, "greet", [], createStdlib(), {
      readLine: async () => "ada",
      print: async (msg: JSONType) => {
        printed.push(msg as string);
        return null;
      },
    });
    expect(result).toBe("ada");
    expect(printed).toEqual(["hi ada"]);
  });

  test("a bare (non-task) return value passes straight through", async () => {
    const mod = moduleOf(`{ answer: () => pure(42) }`);
    expect(await runTask(mod, "answer", [], createStdlib(), {})).toBe(42);
  });

  test("multiple effects run in order with their args", async () => {
    const mod = moduleOf(`{
      run: () => do {
        a <- perform("emit", [1]),
        b <- perform("emit", [2]),
        pure(add(a, b))
      }
    }`);
    const seen: number[] = [];
    const result = await runTask(mod, "run", [], createStdlib(), {
      emit: async (n: JSONType) => {
        seen.push(n as number);
        return (n as number) * 10;
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(result).toBe(30);
  });
});

describe("runTask: host error boundary", () => {
  test("unhandled raise throws TaskRaiseError with the payload", async () => {
    const mod = moduleOf(`{ boom: () => do { _ <- raise({ code: "E" }), pure(1) } }`);
    const promise = runTask(mod, "boom", [], createStdlib(), {});
    expect(promise).rejects.toThrow(TaskRaiseError);
    await promise.catch((e: unknown) => {
      expect((e as TaskRaiseError).payload).toEqual({ code: "E" });
    });
  });

  test("an effect with no capability throws UnhandledEffectError", async () => {
    const mod = moduleOf(`{ main: () => perform("mystery", []) }`);
    const promise = runTask(mod, "main", [], createStdlib(), {});
    expect(promise).rejects.toThrow(UnhandledEffectError);
    await promise.catch((e: unknown) => {
      expect((e as UnhandledEffectError).effect).toBe("mystery");
    });
  });

  test("non-function entry fails fast", async () => {
    const mod = moduleOf(`{ notAFn: 5 }`);
    expect(runTask(mod, "notAFn", [], createStdlib(), {})).rejects.toThrow("not a function");
  });
});

describe("durable suspend: serialize → new process → hydrate → resume", () => {
  // The continuation captured mid-run contains a recursive `where`-local (`go`),
  // so this exercises escaping-closure capture surviving a JSON round-trip.
  const SRC = `{
    main: () => go(3) where {
      go: (n) => if n == 0
        then pure(0)
        else do {
          x    <- perform("tick", [n]),
          rest <- go(n - 1),
          pure(add(x, rest))
        }
    }
  }`;

  test("a suspended continuation resumes in a fresh runtime", () => {
    // Process 1: run to the first suspend, answer it, then persist the *next*
    // task and throw everything else away.
    const p1 = prepareProgram(moduleOf(SRC), createStdlib());
    const first = stepTask(p1.invokeEntry("main", []), p1.call, p1.meter);
    if (!("pending" in first)) throw new Error("expected a pending task");
    expect(first.pending).toMatchObject({ name: "tick", args: [3] });
    const next = p1.call(first.pending.resume, [first.pending.args[0]!]);
    const wire = serializeTask(next);
    expect(typeof wire).toBe("string");

    // Process 2: a brand-new scope + stdlib, only the serialized task survives.
    const p2 = prepareProgram(moduleOf(SRC), createStdlib());
    let task = hydrateTask(wire);
    for (;;) {
      const s = stepTask(task, p2.call, p2.meter);
      if ("done" in s) {
        // ticks answered with their own arg: 3 + 2 + 1 = 6.
        expect(s.done).toBe(6);
        break;
      }
      task = p2.call(s.pending.resume, [s.pending.args[0]!]);
    }
  });

  test("serializeTask / hydrateTask reject non-tasks", () => {
    expect(() => serializeTask({ not: "a task" } as JSONType)).toThrow("not a task");
    expect(() => hydrateTask(JSON.stringify({ not: "a task" }))).toThrow("not a task");
  });
});

describe("runTask: per-hop cancellation", () => {
  test("aborting during a capability stops the next hop", async () => {
    const mod = moduleOf(`{
      main: () => do {
        _ <- perform("step", []),
        _ <- perform("step", []),
        pure("done")
      }
    }`);
    const controller = new AbortController();
    const promise = runTask(
      mod,
      "main",
      [],
      createStdlib(),
      {
        step: async () => {
          controller.abort();
          return null;
        },
      },
      { signal: controller.signal },
    );
    expect(promise).rejects.toThrow("aborted");
  });
});

describe("requiredCapabilities: static admission check", () => {
  const mod = moduleOf(`{
    usesStatic: () => perform("db.read", []),
    usesDynamic: (k) => perform(k, []),
    usesRaise: () => raise("x"),
    discharged: () => handle perform("local", []) with {
      "local": (resume) => resume(1)
    }
  }`);

  test("collects literal effect names, raise, and flags dynamic performs", () => {
    const req = requiredCapabilities(mod);
    // Conservative: the handler-discharged "local" is still reported (the walk
    // does not prove discharge), alongside the static name and raise.
    expect(req.names).toEqual(["db.read", "local", "raise"]);
    expect(req.dynamic).toBe(true);
  });

  test("a fully-static module reports no dynamic effects", () => {
    const staticMod = moduleOf(`{ f: () => perform("only", []) }`);
    expect(requiredCapabilities(staticMod)).toEqual({ names: ["only"], dynamic: false });
  });
});
