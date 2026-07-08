#!/usr/bin/env bun
// jfn — a small CLI for poking at the json-fn language from a terminal.
//
// It exposes the three "directions" the language supports as subcommands:
//   to-shorthand  canonical json-fn JSON  ->  .jfn shorthand
//   to-json       .jfn shorthand          ->  canonical json-fn JSON
//   eval          evaluate a .jfn expression (or module entry) and print it
//
// Input is read from a positional argument, a --file, or stdin (in that order),
// so all three compose well with pipes and heredocs.

import {
  callFunction,
  callProgram,
  createStdlib,
  parseShorthand,
  printShorthand,
  type JSONType,
} from "./index";

const HELP = `jfn — a CLI for the json-fn language

Usage:
  jfn <command> [options] [input]

Commands:
  to-shorthand   Read canonical json-fn JSON, print .jfn shorthand   (alias: j2s, print)
  to-json        Read .jfn shorthand, print canonical json-fn JSON   (alias: s2j, parse)
  eval           Evaluate a .jfn expression and print the result     (alias: e)

Input:
  Pass the source as a positional argument, with --file <path>, or on stdin.
  Use "-" as the input argument to force reading from stdin.

Common options:
  -f, --file <path>   Read input from a file instead of arg/stdin
  -h, --help          Show help

to-json options:
  -c, --compact       Emit minified JSON (default: pretty, 2-space indent)

eval options:
      --entry <name>  Treat input as a module and run this entry function
      --args <json>   JSON array of arguments for the entry (default: [])
  -j, --json          Print the result as JSON (default)
  -s, --shorthand     Print the result as .jfn shorthand (best effort)
  -c, --compact       With --json, emit minified JSON

Examples:
  jfn to-json '1 + 2 * 3'
  echo '{ "$fn": ["add", 1, 2] }' | jfn to-shorthand
  jfn eval '(x) => x * x' --args '[9]'
  jfn eval 'map((n) => n + 1, [1, 2, 3])' --shorthand
  printf '{ inc: (n) => n + 1, main: () => inc(41) }' | jfn eval --entry main
`;

type ParsedArgs = {
  positional: string[];
  flags: Set<string>;
  options: Record<string, string>;
};

// A tiny flag parser: booleans live in `flags`, value-taking options in
// `options`, everything else is positional. Unknown flags are surfaced as an
// error by the callers that inspect what they expect.
function parseArgs(
  argv: string[],
  valueOptions: Record<string, string>,
  booleanOptions: Record<string, string>,
): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      // Support `--opt=value` form.
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

      const canonicalValue = valueOptions[name];
      const canonicalBool = booleanOptions[name];

      if (canonicalValue !== undefined) {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) throw new Error(`Option ${name} requires a value`);
        options[canonicalValue] = value;
      } else if (canonicalBool !== undefined) {
        flags.add(canonicalBool);
      } else {
        throw new Error(`Unknown option: ${name}`);
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, options };
}

async function readInput(parsed: ParsedArgs): Promise<string> {
  const file = parsed.options.file;
  if (file !== undefined) {
    return await Bun.file(file).text();
  }
  // A positional arg (that isn't the stdin sentinel) is treated as inline source.
  const inline = parsed.positional.find((p) => p !== "-");
  if (inline !== undefined) return inline;
  return await Bun.stdin.text();
}

function fail(message: string): never {
  console.error(`jfn: ${message}`);
  process.exit(1);
}

async function cmdToShorthand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "-f": "file", "--file": "file" }, {});
  let json: JSONType;
  const raw = await readInput(parsed);
  try {
    json = JSON.parse(raw) as JSONType;
  } catch (e) {
    fail(`invalid JSON input: ${errMessage(e)}`);
  }
  try {
    console.log(printShorthand(json));
  } catch (e) {
    fail(`could not print shorthand: ${errMessage(e)}`);
  }
}

async function cmdToJson(argv: string[]): Promise<void> {
  const parsed = parseArgs(
    argv,
    { "-f": "file", "--file": "file" },
    { "-c": "compact", "--compact": "compact" },
  );
  const src = await readInput(parsed);
  let json: JSONType;
  try {
    json = parseShorthand(src);
  } catch (e) {
    fail(`could not parse shorthand: ${errMessage(e)}`);
  }
  console.log(stringify(json, parsed.flags.has("compact")));
}

async function cmdEval(argv: string[]): Promise<void> {
  const parsed = parseArgs(
    argv,
    {
      "-f": "file",
      "--file": "file",
      "--entry": "entry",
      "--args": "args",
    },
    {
      "-j": "json",
      "--json": "json",
      "-s": "shorthand",
      "--shorthand": "shorthand",
      "-c": "compact",
      "--compact": "compact",
    },
  );

  const src = await readInput(parsed);

  let parsedSource: JSONType;
  try {
    parsedSource = parseShorthand(src);
  } catch (e) {
    fail(`could not parse shorthand: ${errMessage(e)}`);
  }

  let args: JSONType[] = [];
  if (parsed.options.args !== undefined) {
    try {
      const decoded = JSON.parse(parsed.options.args) as JSONType;
      if (!Array.isArray(decoded)) throw new Error("must be a JSON array");
      args = decoded;
    } catch (e) {
      fail(`invalid --args: ${errMessage(e)}`);
    }
  }

  const stdlib = createStdlib({
    logger: (value, label) => console.error(label ? `${label}:` : "log:", value),
  });

  let result: JSONType;
  try {
    const entry = parsed.options.entry;
    if (entry !== undefined) {
      // Module mode: the source is an object of bindings; run the named entry.
      result = callProgram(parsedSource as Record<string, JSONType>, entry, args, stdlib);
    } else if (isFunctionBody(parsedSource) && args.length > 0) {
      // A bare function literal applied to the supplied --args.
      result = callFunction(parsedSource, args, stdlib);
    } else {
      // A bare expression is evaluated as the body of a zero-arg function so it
      // runs through the same interpreter path everything else uses.
      result = callFunction({ $return: parsedSource }, args, stdlib);
    }
  } catch (e) {
    fail(`evaluation error: ${errMessage(e)}`);
  }

  if (parsed.flags.has("shorthand")) {
    try {
      console.log(printShorthand(result));
    } catch (e) {
      fail(`could not print result as shorthand: ${errMessage(e)}`);
    }
  } else {
    console.log(stringify(result, parsed.flags.has("compact")));
  }
}

function isFunctionBody(value: JSONType): value is { $return: JSONType } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "$return" in value;
}

function stringify(value: JSONType, compact: boolean): string {
  return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "to-shorthand":
    case "j2s":
    case "print":
      await cmdToShorthand(rest);
      break;
    case "to-json":
    case "s2j":
    case "parse":
      await cmdToJson(rest);
      break;
    case "eval":
    case "e":
      await cmdEval(rest);
      break;
    default:
      fail(`unknown command "${command}". Run "jfn --help" for usage.`);
  }
}

main().catch((e) => fail(errMessage(e)));
