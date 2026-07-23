// dungeon.ts — interactive host for examples/dungeon.jfn.
//
// The game's `play` loop performs exactly two effects — `input` (read a
// command) and `print` (show a line) — declared by the operator-owned
// contract. The dungeon's own `runScript` handler interprets them *in-language*
// for its demos; this host instead answers them from a real terminal via
// `runTask`, so the same pure game logic becomes a playable game.
//
// `input` is an async capability (it awaits a line of stdin), which the
// trampoline handles transparently: each suspended `{ pending: "input" }` is
// answered by `await`-ing the next line and resuming the continuation. EOF
// resolves to null, which the loop already treats as "narrator ran out of
// script" and ends gracefully.
//
// Play it:            bun run typescript/examples/dungeon.ts
// Or feed it a script:
//   printf 'take\ngo north\ngo east\nunlock\n' | bun run typescript/examples/dungeon.ts

import {
  runTask,
  loadEnvironmentContract,
  loadDeploymentProfile,
  parseShorthand,
  prepareDeployment,
  TaskRaiseError,
  type JSONType,
} from "../src";
import { readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const source = readFileSync(join(import.meta.dir, "../../examples/dungeon.jfn"), "utf-8");
const game = parseShorthand(source) as Record<string, JSONType>;
const contract = loadEnvironmentContract(
  join(import.meta.dir, "../../examples/dungeon.contract.json"),
);
const profile = loadDeploymentProfile(
  join(import.meta.dir, "../../examples/dungeon.profile.json"),
  contract,
);
if (profile.mode !== "live") throw new Error("dungeon requires a live deployment profile");

// A promise-based line reader over stdin. Resolves to null at EOF — the very
// sentinel the dungeon's `play` loop checks with `isNull(cmd)`.
const rl = createInterface({ input: process.stdin });
const buffered: string[] = [];
const waiters: ((line: string | null) => void)[] = [];
let closed = false;

rl.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else buffered.push(line);
});
rl.on("close", () => {
  closed = true;
  while (waiters.length) waiters.shift()!(null);
});

const nextLine = (): Promise<string | null> => {
  if (buffered.length) return Promise.resolve(buffered.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
};

const capabilities = {
  // Async: the trampoline awaits this before resuming the game's continuation.
  input: async (): Promise<JSONType> => await nextLine(),
  print: (msg: JSONType): JSONType => {
    console.log(msg as string);
    return null;
  },
};

const start: JSONType = { at: "cell", held: [] };
try {
  const ending = await runTask(
    prepareDeployment({
      module: game,
      contract,
      profile,
      adapter: { functions: {}, effects: capabilities },
    }),
    [start],
  );
  rl.close();
  console.log(`\n${ending as string}`);
  process.exit(0);
} catch (err) {
  rl.close();
  // A guest `raise` the game never handled comes back as a structured payload;
  // any other evaluator error (bad property key, fuel/depth limit, …) is a bug
  // in the game logic — print it as one clean line instead of dumping the host
  // stack trace at the player.
  if (err instanceof TaskRaiseError) {
    console.error(`\nThe dungeon reports an unhandled problem: ${JSON.stringify(err.payload)}`);
  } else {
    console.error(`\nThe dungeon collapsed (bug in the game logic): ${(err as Error).message}`);
  }
  process.exit(1);
}
