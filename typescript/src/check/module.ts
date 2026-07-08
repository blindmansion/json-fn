// Check a single function body against its declared signature: build its Γ,
// then check its `$return` against the declared return type. Nested function

import type { JSONType } from "../types";
import type { BuiltinTable } from "./builtin-types";
import { buildTypeScope, check, synth } from "./checker";
import {
  at,
  bindingKeys,
  EMPTY_ENV,
  isBody,
  sigOf,
  type CheckContext,
  type Diagnostic,
} from "./context";
import { type Defs, isSchemaObject, type Schema } from "./schema";

// locals are checked recursively in the body's own scope.
function checkFunction(body: Record<string, JSONType>, ctx: CheckContext): void {
  const sig = sigOf(body);
  const env = buildTypeScope(body, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env };
  check(body.$return!, sig?.returns ?? true, at(bctx, "$return"));
  for (const key of bindingKeys(body)) {
    const val = body[key]!;
    if (isBody(val)) checkFunction(val, at(bctx, key));
  }
}

// Public entry, mirroring `callProgram`: lift `$types` into the defs pool, wire
// the module scope (function `$fnType`s eager, constants lazy), then check each
// function body. Returns all accumulated diagnostics.
function checkModule(module: Record<string, JSONType>, builtins?: BuiltinTable): Diagnostic[] {
  const moduleDefs: Defs = isSchemaObject(module.$types) ? (module.$types as Defs) : {};
  // Builtin-owned named types (`Match`, …) merge into the pool; module types
  // win on a name clash.
  const defs: Defs = { ...builtins?.$defs, ...moduleDefs };
  const ctx: CheckContext = {
    defs,
    env: EMPTY_ENV,
    diagnostics: [],
    path: [],
    builtins: builtins?.builtins,
  };
  const env = buildTypeScope(withoutTypes(module), null, ctx);
  ctx.env = env;

  for (const key of bindingKeys(withoutTypes(module))) {
    const val = module[key]!;
    if (isBody(val)) {
      checkFunction(val, { ...ctx, env, path: [key] });
    } else {
      // Force top-level constants so their bodies get walked for errors even
      // when nothing references them.
      env.lookupType(key);
    }
  }
  return ctx.diagnostics;
}

// The module minus its reserved `$types` sibling, so the type pool is not
// mistaken for a term binding.
function withoutTypes(module: Record<string, JSONType>): Record<string, JSONType> {
  if (!("$types" in module)) return module;
  const { $types, ...rest } = module;
  void $types;
  return rest;
}

// Synthesize the type of a standalone expression (for the CLI/REPL). Returns
// the inferred schema and any diagnostics gathered.
function checkExpr(
  expr: JSONType,
  defs: Defs = {},
  builtins?: BuiltinTable,
): { type: Schema; diagnostics: Diagnostic[] } {
  const merged: Defs = { ...builtins?.$defs, ...defs };
  const ctx: CheckContext = {
    defs: merged,
    env: EMPTY_ENV,
    diagnostics: [],
    path: [],
    builtins: builtins?.builtins,
  };
  return { type: synth(expr, ctx), diagnostics: ctx.diagnostics };
}

export { checkFunction, checkModule, checkExpr };
