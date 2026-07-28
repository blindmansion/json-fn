#!/usr/bin/env bun
// jfn — a small CLI for poking at the json-fn language from a terminal.
//
// It exposes the "directions" the language supports as subcommands:
//   to-shorthand  canonical json-fn JSON  ->  .jfn shorthand
//   to-json       .jfn shorthand          ->  canonical json-fn JSON
//   eval          evaluate a .jfn expression (or module entry) and print it
//   check         parse a .jfn expression/module and typecheck it
//   validate-*    validate portable deployment artifacts
//
// Input is read from a positional argument, a --file, or stdin (in that order),
// so all three compose well with pipes and heredocs.

import {
  callFunction,
  callProgram,
  createStdlib,
  parseShorthand,
  parseShorthandExpression,
  parseShorthandExpressionWithPositions,
  parseShorthandModuleWithPositions,
  prepareDeployment,
  printShorthand,
  printShorthandExpression,
  resolvePathPosition,
  runTask,
  validateEnvironmentContract,
  validateDeploymentProfile,
  type ExecutionLimits,
  type JSONType,
  type SourcePos,
} from "./index";
import { existsSync } from "fs";
import { checkExpr, checkModule } from "./check/module";
import type { Diagnostic } from "./check/context";
import type { CallableTable } from "./check/builtin-types";
import { loadBuiltinTable } from "./builtins";
import { loadEnvironmentContract } from "./environment/environment";
import type { EnvironmentContract } from "./environment/types";
import { isFunctionBody } from "./function-value";
import { linkModule } from "./module-linker";

const HELP = `jfn — a CLI for the json-fn language

Usage:
  jfn <command> [options] [input]

Commands:
  to-shorthand   Read canonical json-fn JSON, print .jfn shorthand   (alias: j2s, print)
  to-json        Read .jfn shorthand, print canonical json-fn JSON   (alias: s2j, parse)
  eval           Invoke a .jfn module function and print the result  (alias: e)
  check          Typecheck a canonical json-fn module or expression  (alias: c)
  validate-contract
                  Validate a portable contract JSON artifact
  validate-profile
                  Validate a portable deployment profile JSON artifact

Input:
  Pass the source as a positional argument, with --file <path>, or on stdin.
  Use "-" as the input argument to force reading from stdin. A positional
  argument is inline source text, never a file path — use --file for files.

Common options:
  -f, --file <path>   Read input from a file instead of arg/stdin
  -h, --help          Show help

to-shorthand options:
  -e, --expr          Print one standalone expression instead of a module

to-json options:
  -c, --compact       Emit minified JSON (default: pretty, 2-space indent)
  -e, --expr          Parse one standalone expression instead of a module

eval options:
      --contract <path>
                      Run the contract entry with an empty adapter; the contract
                      must declare no direct host functions
      --function <name>
                      Development-only invocation of a named module function;
                      --contract is optional
      --args <json>   JSON array of function/entry arguments (default: [])
      --max-call-depth <n>
                      Maximum nested guest function calls (default: 256)
      --max-fuel <n>  Maximum metered work (default: unlimited)
      --max-value-size <n>
                      Maximum produced array/string length (default: unlimited)
      --json-input    Read canonical json-fn JSON instead of .jfn shorthand
  -e, --expr          Evaluate one standalone expression instead of a module
  -j, --json          Print the result as JSON (default)
  -s, --shorthand     Print the result as .jfn shorthand (best effort)
  -c, --compact       With --json, emit minified JSON

check options:
      Parses .jfn shorthand (including type annotations) and typechecks it. By
      default the input is treated as a module; use --expr for one expression.
      Diagnostics on shorthand input include source positions (line:col).
  -e, --expr          Check a single expression and print its inferred type
      --json, --json-input
                      Read canonical json-fn JSON instead of .jfn shorthand
      --json-diagnostics
                      Emit diagnostics as a JSON array (path/message/severity/
                      expected/actual) instead of prose
      --no-builtins   Don't load the builtin signature table (spec/builtins.json)
      --contract <path>
                      Load an operator-owned portable contract JSON file
      --allow-untyped-functions
                      Allow named functions without a declared $sig
      --require-full-coverage
                      Exit non-zero when any expression degrades to any
  -c, --compact       Emit JSON output (inferred type, --json-diagnostics) minified

validate-profile options:
      --contract <path>
                      EnvironmentContract used to validate selected profile effects

Examples:
  jfn to-json --expr '1 + 2 * 3'
  echo '{ "$call": "add", "$args": [1, 2] }' | jfn to-shorthand --expr
  jfn eval --expr '(x) => x * x' --args '[9]'
  jfn eval 'demo: () => map((n) => n + 1, [1, 2, 3])' --function demo
  jfn eval --file module.jfn --function demo
  jfn eval --file module.jfn --contract module.contract.json
  jfn eval --file module.jfn --contract module.contract.json --function demo
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
  if (inline !== undefined) {
    // Guard the classic mistake of passing a file path positionally: inline
    // source that names an existing file is almost certainly a missing --file.
    if ((/[\\/]/.test(inline) || /\.(jfn|json)$/i.test(inline)) && existsSync(inline)) {
      fail(
        `positional input is treated as inline source, but "${inline}" is an existing file — did you mean --file ${inline}?`,
      );
    }
    return inline;
  }
  return await Bun.stdin.text();
}

function fail(message: string): never {
  console.error(`jfn: ${message}`);
  process.exit(1);
}

async function cmdToShorthand(argv: string[]): Promise<void> {
  const parsed = parseArgs(
    argv,
    { "-f": "file", "--file": "file" },
    { "-e": "expr", "--expr": "expr" },
  );
  let json: JSONType;
  const raw = await readInput(parsed);
  try {
    json = JSON.parse(raw) as JSONType;
  } catch (e) {
    fail(`invalid JSON input: ${errMessage(e)}`);
  }
  try {
    console.log(parsed.flags.has("expr") ? printShorthandExpression(json) : printShorthand(json));
  } catch (e) {
    fail(`could not print shorthand: ${errMessage(e)}`);
  }
}

async function cmdToJson(argv: string[]): Promise<void> {
  const parsed = parseArgs(
    argv,
    { "-f": "file", "--file": "file" },
    { "-c": "compact", "--compact": "compact", "-e": "expr", "--expr": "expr" },
  );
  const src = await readInput(parsed);
  let json: JSONType;
  try {
    json = parsed.flags.has("expr") ? parseShorthandExpression(src) : parseShorthand(src);
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
      "--contract": "contract",
      "--function": "function",
      "--args": "args",
      "--max-call-depth": "max-call-depth",
      "--max-fuel": "max-fuel",
      "--max-value-size": "max-value-size",
    },
    {
      "--json-input": "json-input",
      "-e": "expr",
      "--expr": "expr",
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
  if (parsed.flags.has("json-input")) {
    try {
      parsedSource = JSON.parse(src) as JSONType;
    } catch (e) {
      fail(`invalid JSON input: ${errMessage(e)}`);
    }
  } else {
    try {
      parsedSource = parsed.flags.has("expr") ? parseShorthandExpression(src) : parseShorthand(src);
    } catch (e) {
      fail(`could not parse shorthand: ${errMessage(e)}`);
    }
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

  const limits: ExecutionLimits = {};
  for (const [option, field] of [
    ["max-call-depth", "maxCallDepth"],
    ["max-fuel", "maxFuel"],
    ["max-value-size", "maxValueSize"],
  ] as const) {
    const raw = parsed.options[option];
    if (raw !== undefined) limits[field] = parseNonNegativeIntegerOption(`--${option}`, raw);
  }

  const stdlib = createStdlib({
    logger: (value, label) => console.error(label ? `${label}:` : "tap:", value),
  });
  let builtins: CallableTable;
  try {
    builtins = loadBuiltinTable();
  } catch (e) {
    fail(`could not load builtin table: ${errMessage(e)}`);
  }
  const definitions = { builtinDefs: builtins.$defs };

  let result: JSONType;
  try {
    const contractPath = parsed.options.contract;
    const functionName = parsed.options.function;
    const expressionMode = parsed.flags.has("expr");
    if (expressionMode && (contractPath !== undefined || functionName !== undefined)) {
      fail("--expr cannot be combined with --contract or --function");
    }
    if (contractPath !== undefined) {
      if (
        typeof parsedSource !== "object" ||
        parsedSource === null ||
        Array.isArray(parsedSource)
      ) {
        fail("--contract requires module input");
      }
      const contract = loadEnvironmentContract(contractPath, builtins);
      const module = parsedSource as Record<string, JSONType>;
      if (functionName !== undefined) {
        const linked = linkModule({ module, builtins, contract });
        result = callProgram(
          linked.module,
          functionName,
          args,
          stdlib,
          limits,
          linked.definitionSources,
        );
      } else {
        result = await runTask(
          prepareDeployment({
            module,
            contract,
            profile: { version: 1, mode: "live", effects: [], limits },
            adapter: { functions: {}, effects: {} },
          }),
          args,
        );
      }
    } else if (functionName !== undefined) {
      if (
        typeof parsedSource !== "object" ||
        parsedSource === null ||
        Array.isArray(parsedSource)
      ) {
        fail("--function requires module input");
      }
      const linked = linkModule({
        module: parsedSource as Record<string, JSONType>,
        builtins,
      });
      result = callProgram(
        linked.module,
        functionName,
        args,
        stdlib,
        limits,
        linked.definitionSources,
      );
    } else if (!expressionMode) {
      fail("module evaluation requires --function or --contract; pass --expr for an expression");
    } else if (isFunctionBody(parsedSource)) {
      // A bare function literal applied to the supplied --args.
      result = callFunction(parsedSource, args, stdlib, limits, definitions);
    } else {
      // A bare expression is evaluated as the body of a zero-arg function so it
      // runs through the same interpreter path everything else uses.
      result = callFunction({ $return: parsedSource }, args, stdlib, limits, definitions);
    }
  } catch (e) {
    fail(`evaluation error: ${errMessage(e)}`);
  }

  if (parsed.flags.has("shorthand")) {
    try {
      console.log(printShorthandExpression(result));
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
      "--contract": "contract",
    },
    {
      "-e": "expr",
      "--expr": "expr",
      "--json": "json-input",
      "--json-input": "json-input",
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
  // For shorthand input, resolve each diagnostic's canonical-JSON path back to
  // a `.jfn` source position so messages point at the line the author wrote.
  let locate: ((d: Diagnostic) => SourcePos | undefined) | undefined;
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
      const withPositions = parsed.flags.has("expr")
        ? parseShorthandExpressionWithPositions(src)
        : parseShorthandModuleWithPositions(src);
      json = withPositions.value;
      const root = withPositions.value;
      const positions = withPositions.positions;
      locate = (d) => resolvePathPosition(root, positions, d.path);
    } catch (e) {
      fail(`could not parse shorthand: ${errMessage(e)}`);
    }
  }

  // Builtins are on by default — most real code (the chess example, anything
  // using map/filter/arithmetic) is untypeable without them. `--no-builtins`
  // removes those names from the checker registry.
  let builtins: CallableTable | undefined;
  if (!parsed.flags.has("no-builtins")) {
    try {
      builtins = loadBuiltinTable();
    } catch (e) {
      fail(`could not load builtin table: ${errMessage(e)}`);
    }
  }
  let contract: EnvironmentContract | undefined;
  if (parsed.options.contract !== undefined) {
    try {
      contract = loadEnvironmentContract(parsed.options.contract, builtins ?? false);
    } catch (e) {
      fail(`could not load contract: ${errMessage(e)}`);
    }
  }

  const compact = parsed.flags.has("compact");
  const requireFullCoverage = parsed.flags.has("require-full-coverage");
  const jsonDiagnostics = parsed.flags.has("json-diagnostics");
  const sourceLabel = parsed.options.file;

  if (parsed.flags.has("expr")) {
    const { type, diagnostics } = checkExpr(json, {}, builtins, {
      contract,
      allowUntypedFunctions: parsed.flags.has("allow-untyped-functions"),
    });
    if (jsonDiagnostics) {
      reportDiagnosticsJson(diagnostics, compact, locate);
    } else {
      console.log(`type: ${stringify(type, compact)}`);
      reportDiagnostics(diagnostics, locate, sourceLabel);
    }
    exitFromDiagnostics(diagnostics, requireFullCoverage);
    return;
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("check expects a module object; pass --expr to check a single expression");
  }

  const diagnostics = checkModule(json as Record<string, JSONType>, builtins, {
    allowUntypedFunctions: parsed.flags.has("allow-untyped-functions"),
    contract,
  });
  if (jsonDiagnostics) {
    reportDiagnosticsJson(diagnostics, compact, locate);
  } else {
    reportDiagnostics(diagnostics, locate, sourceLabel);
  }
  exitFromDiagnostics(diagnostics, requireFullCoverage);
}

async function cmdValidateContract(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "-f": "file", "--file": "file" }, {});
  const value = await readJsonArtifact(parsed);
  try {
    validateEnvironmentContract(value);
  } catch (e) {
    fail(`invalid contract: ${errMessage(e)}`);
  }
  console.log("Valid contract.");
}

async function cmdValidateProfile(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "-f": "file", "--file": "file", "--contract": "contract" }, {});
  const contractPath = parsed.options.contract;
  if (contractPath === undefined) fail("validate-profile requires --contract <path>");
  const value = await readJsonArtifact(parsed);
  try {
    const contract = loadEnvironmentContract(contractPath);
    validateDeploymentProfile(value, contract);
  } catch (e) {
    fail(`invalid deployment profile: ${errMessage(e)}`);
  }
  console.log("Valid deployment profile.");
}

async function readJsonArtifact(parsed: ParsedArgs): Promise<unknown> {
  const raw = await readInput(parsed);
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    fail(`invalid JSON input: ${errMessage(e)}`);
  }
}

// Emit the raw `Diagnostic[]` as JSON (pretty by default, minified with
// --compact). Every field is stable: `path`, `message`, `severity`, and the
// optional `expected` / `actual` schemas — plus, for shorthand input, the
// 1-based `line`/`col` of the source the diagnostic maps back to. This is the
// machine-readable counterpart to `reportDiagnostics`; consumers can jump
// straight to a diagnostic's `path` and inspect the schemas rather than
// parsing prose.
function reportDiagnosticsJson(
  diags: Diagnostic[],
  compact: boolean,
  locate?: (d: Diagnostic) => SourcePos | undefined,
): void {
  const out =
    locate === undefined
      ? diags
      : diags.map((d) => {
          const pos = locate(d);
          return pos === undefined ? d : { ...d, line: pos.line, col: pos.col };
        });
  console.log(compact ? JSON.stringify(out) : JSON.stringify(out, null, 2));
}

// Print each diagnostic as `severity: location: message` (the message already
// embeds the compact schemas), then the error and coverage summaries. For
// shorthand input, `locate` maps the canonical-JSON path back to the `.jfn`
// source and the line is suffixed with ` (at [file:]line:col)`.
function reportDiagnostics(
  diags: Diagnostic[],
  locate?: (d: Diagnostic) => SourcePos | undefined,
  file?: string,
): void {
  for (const d of diags) {
    const loc = d.path.length > 0 ? d.path.join(".") : "<root>";
    const pos = locate?.(d);
    const where =
      pos === undefined
        ? ""
        : ` (at ${file === undefined ? "" : `${file}:`}${pos.line}:${pos.col})`;
    console.log(`${d.severity}: ${loc}: ${d.message}${where}`);
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

function parseNonNegativeIntegerOption(option: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`invalid ${option}: expected a non-negative integer`);
  }
  return value;
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
    case "validate-contract":
      await cmdValidateContract(rest);
      break;
    case "validate-profile":
      await cmdValidateProfile(rest);
      break;
    default:
      fail(`unknown command "${command}". Run "jfn --help" for usage.`);
  }
}

main().catch((e) => fail(errMessage(e)));
