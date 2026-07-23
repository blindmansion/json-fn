#!/usr/bin/env bun
// jfn — a small CLI for poking at the json-fn language from a terminal.
//
// It exposes the "directions" the language supports as subcommands:
//   to-shorthand  canonical json-fn JSON  ->  .jfn shorthand
//   to-json       .jfn shorthand          ->  canonical json-fn JSON
//   eval          evaluate a .jfn expression (or module entry) and print it
//   check         parse a .jfn expression/module and typecheck it
//
// Input is read from a positional argument, a --file, or stdin (in that order),
// so all three compose well with pipes and heredocs.

import {
  callFunction,
  callProgram,
  createStdlib,
  parseShorthand,
  printShorthand,
  runTask,
  type JSONType,
} from "./index";
import { checkExpr, checkModule } from "./check/module";
import type { Diagnostic } from "./check/context";
import type { CallableTable } from "./check/builtin-types";
import { loadBuiltinTable } from "./builtins";
import { buildEffectNamespace, EFFECTS_BINDING } from "./environment/effects";
import { loadEnvironment } from "./environment/environment";
import type { Environment } from "./environment/types";
import { isFunctionBody } from "./function-value";

const HELP = `jfn — a CLI for the json-fn language

Usage:
  jfn <command> [options] [input]

Commands:
  to-shorthand   Read canonical json-fn JSON, print .jfn shorthand   (alias: j2s, print)
  to-json        Read .jfn shorthand, print canonical json-fn JSON   (alias: s2j, parse)
  eval           Evaluate a .jfn expression and print the result     (alias: e)
  check          Typecheck a canonical json-fn module or expression  (alias: c)

Input:
  Pass the source as a positional argument, with --file <path>, or on stdin.
  Use "-" as the input argument to force reading from stdin.

Common options:
  -f, --file <path>   Read input from a file instead of arg/stdin
  -h, --help          Show help

to-json options:
  -c, --compact       Emit minified JSON (default: pretty, 2-space indent)

eval options:
      --environment <path>
                      Treat input as a module and run the environment entry
      --function <name>
                      Unchecked development invocation using the environment
                      definitions and generated effects API
      --args <json>   JSON array of function/entry arguments (default: [])
  -j, --json          Print the result as JSON (default)
  -s, --shorthand     Print the result as .jfn shorthand (best effort)
  -c, --compact       With --json, emit minified JSON

check options:
      Parses .jfn shorthand (including type annotations) and typechecks it. By
      default the input is treated as a module; use --expr for one expression.
  -e, --expr          Check a single expression and print its inferred type
      --json          Read canonical json-fn JSON instead of .jfn shorthand
      --json-diagnostics
                      Emit diagnostics as a JSON array (path/message/severity/
                      expected/actual) instead of prose
      --no-builtins   Don't load the builtin signature table (spec/builtins.json)
      --environment <path>
                      Load an operator-owned typed environment JSON file
      --allow-untyped-functions
                      Don't require top-level functions to declare a $sig
      --require-full-coverage
                      Exit non-zero when any expression degrades to any
  -c, --compact       Emit JSON output (inferred type, --json-diagnostics) minified

Examples:
  jfn to-json '1 + 2 * 3'
  echo '{ "$call": "add", "$args": [1, 2] }' | jfn to-shorthand
  jfn eval '(x) => x * x' --args '[9]'
  jfn eval 'map((n) => n + 1, [1, 2, 3])' --shorthand
  jfn eval --file module.jfn --environment module.environment.json
  jfn eval --file module.jfn --environment module.environment.json --function demo
  jfn check --expr 'add(1, 2)'
  jfn check --file ../examples/typed/types.jfn
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
      "--environment": "environment",
      "--function": "function",
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
    logger: (value, label) => console.error(label ? `${label}:` : "tap:", value),
  });
  let builtinDefs: CallableTable["$defs"];
  try {
    builtinDefs = loadBuiltinTable().$defs;
  } catch (e) {
    fail(`could not load builtin table: ${errMessage(e)}`);
  }
  const definitions = { builtinDefs };

  let result: JSONType;
  try {
    const environmentPath = parsed.options.environment;
    const functionName = parsed.options.function;
    if (functionName !== undefined && environmentPath === undefined) {
      fail("--function requires --environment");
    }
    if (environmentPath !== undefined) {
      if (
        typeof parsedSource !== "object" ||
        parsedSource === null ||
        Array.isArray(parsedSource)
      ) {
        fail("--environment requires module input");
      }
      const environment = loadEnvironment(environmentPath, builtinDefs);
      const module = parsedSource as Record<string, JSONType>;
      if (functionName !== undefined) {
        if (Object.prototype.hasOwnProperty.call(module, EFFECTS_BINDING)) {
          fail(`"${EFFECTS_BINDING}" is reserved for environment-declared effects`);
        }
        result = callProgram(
          {
            ...module,
            [EFFECTS_BINDING]: buildEffectNamespace(environment.effects),
          },
          functionName,
          args,
          stdlib,
          undefined,
          {
            builtinDefs,
            environmentDefs: environment.$defs,
          },
        );
      } else {
        result = await runTask(module, environment, args, {
          registry: stdlib,
          capabilities: {},
        });
      }
    } else if (isFunctionBody(parsedSource)) {
      // A bare function literal applied to the supplied --args.
      result = callFunction(parsedSource, args, stdlib, undefined, definitions);
    } else {
      // A bare expression is evaluated as the body of a zero-arg function so it
      // runs through the same interpreter path everything else uses.
      result = callFunction({ $return: parsedSource }, args, stdlib, undefined, definitions);
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

async function cmdCheck(argv: string[]): Promise<void> {
  const parsed = parseArgs(
    argv,
    {
      "-f": "file",
      "--file": "file",
      "--environment": "environment",
    },
    {
      "-e": "expr",
      "--expr": "expr",
      "--json": "json-input",
      "--json-diagnostics": "json-diagnostics",
      "--no-builtins": "no-builtins",
      "--allow-untyped-functions": "allow-untyped-functions",
      "--require-full-coverage": "require-full-coverage",
      "-c": "compact",
      "--compact": "compact",
    },
  );

  const src = await readInput(parsed);
  let json: JSONType;
  if (parsed.flags.has("json-input")) {
    // Escape hatch: read canonical json-fn JSON directly, skipping the parser.
    // Useful for `to-json | check` pipelines and other machine-produced input.
    try {
      json = JSON.parse(src) as JSONType;
    } catch (e) {
      fail(`invalid JSON input: ${errMessage(e)}`);
    }
  } else {
    try {
      json = parseShorthand(src);
    } catch (e) {
      fail(`could not parse shorthand: ${errMessage(e)}`);
    }
  }

  // Builtins are on by default — most real code (the chess example, anything
  // using map/filter/arithmetic) is untypeable without them. `--no-builtins`
  // mirrors the pre-Section-F behavior where builtin calls degrade to `any`.
  let builtins: CallableTable | undefined;
  if (!parsed.flags.has("no-builtins")) {
    try {
      builtins = loadBuiltinTable();
    } catch (e) {
      fail(`could not load builtin table: ${errMessage(e)}`);
    }
  }
  let environment: Environment | undefined;
  if (parsed.options.environment !== undefined) {
    try {
      environment = loadEnvironment(parsed.options.environment, builtins?.$defs);
    } catch (e) {
      fail(`could not load environment: ${errMessage(e)}`);
    }
  }

  const compact = parsed.flags.has("compact");
  const requireFullCoverage = parsed.flags.has("require-full-coverage");
  const jsonDiagnostics = parsed.flags.has("json-diagnostics");

  if (parsed.flags.has("expr")) {
    const { type, diagnostics } = checkExpr(json, {}, builtins, { environment });
    if (jsonDiagnostics) {
      reportDiagnosticsJson(diagnostics, compact);
    } else {
      console.log(`type: ${stringify(type, compact)}`);
      reportDiagnostics(diagnostics);
    }
    exitFromDiagnostics(diagnostics, requireFullCoverage);
    return;
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("check expects a module object; pass --expr to check a single expression");
  }

  const diagnostics = checkModule(json as Record<string, JSONType>, builtins, {
    requireTypedModuleFunctions: !parsed.flags.has("allow-untyped-functions"),
    environment,
  });
  if (jsonDiagnostics) {
    reportDiagnosticsJson(diagnostics, compact);
  } else {
    reportDiagnostics(diagnostics);
  }
  exitFromDiagnostics(diagnostics, requireFullCoverage);
}

// Emit the raw `Diagnostic[]` as JSON (pretty by default, minified with
// --compact). Every field is stable: `path`, `message`, `severity`, and the
// optional `expected` / `actual` schemas. This is the machine-readable
// counterpart to `reportDiagnostics`; consumers can jump straight to a
// diagnostic's `path` and inspect the schemas rather than parsing prose.
function reportDiagnosticsJson(diags: Diagnostic[], compact: boolean): void {
  console.log(compact ? JSON.stringify(diags) : JSON.stringify(diags, null, 2));
}

// Print each diagnostic as `severity: location: message` (the message already
// embeds the compact schemas), then the error and coverage summaries.
function reportDiagnostics(diags: Diagnostic[]): void {
  for (const d of diags) {
    const loc = d.path.length > 0 ? d.path.join(".") : "<root>";
    console.log(`${d.severity}: ${loc}: ${d.message}`);
  }
  const errors = diags.filter((d) => d.severity === "error").length;
  const degradations = diags.filter((d) => d.severity === "info").length;
  if (diags.length === 0) {
    console.log("No type errors.");
  } else {
    console.log(`\n${errors} error${errors === 1 ? "" : "s"}.`);
  }
  if (degradations === 0) {
    console.log("Type coverage: complete (no dynamic degradations).");
  } else {
    console.log(
      `Type coverage: incomplete (${degradations} dynamic degradation site${degradations === 1 ? "" : "s"}).`,
    );
  }
}

// Exit non-zero for errors, or optionally for lost coverage.
function exitFromDiagnostics(diags: Diagnostic[], requireFullCoverage: boolean): void {
  const hasError = diags.some((d) => d.severity === "error");
  const hasDegradation = diags.some((d) => d.severity === "info");
  if (hasError || (requireFullCoverage && hasDegradation)) {
    process.exit(1);
  }
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
    case "check":
    case "c":
      await cmdCheck(rest);
      break;
    default:
      fail(`unknown command "${command}". Run "jfn --help" for usage.`);
  }
}

main().catch((e) => fail(errMessage(e)));
