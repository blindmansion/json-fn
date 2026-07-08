// Check a single function body against its declared signature: build its Γ,
// then check its `$return` against the declared return type. Nested function

import type { JSONType } from "../types";
import type { BuiltinTable } from "./builtin-types";
import { synthBuiltinCall } from "./builtin-rules";
import { buildTypeScope, check, synth } from "./checker";
import {
  at,
  bindingKeys,
  EMPTY_ENV,
  isBody,
  sigOf,
  stableStringify,
  type CheckContext,
  type Diagnostic,
} from "./context";
import { type Defs, isSchemaObject, type Schema } from "./schema";

// locals are checked recursively in the body's own scope.
function checkFunction(body: Record<string, JSONType>, ctx: CheckContext): void {
  const sig = sigOf(body);
  const { env, guards } = buildTypeScope(body, ctx.env, ctx);
  const bctx: CheckContext = { ...ctx, env, guards };
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
    synthBuiltinCall,
  };
  const { env, guards } = buildTypeScope(withoutTypes(module), null, ctx);
  ctx.env = env;
  ctx.guards = guards;

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
  return dedupeDiagnostics(ctx.diagnostics);
}

// Drop later diagnostics structurally equal to an earlier one (§5.5 M2 §2.2d).
// A lazy local forced under two distinct fact sets re-synthesizes once per set,
// so a mismatch inside it can be reported twice; deduping keeps the first and
// is order-stable. A diagnostic present only under a *later* arm differs
// structurally, so it survives — this is not first-seen suppression.
function dedupeDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diags) {
    const key = stableStringify([
      d.path,
      d.message,
      d.severity,
      d.expected ?? null,
      d.actual ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
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
    synthBuiltinCall,
  };
  return { type: synth(expr, ctx), diagnostics: ctx.diagnostics };
}

export { checkFunction, checkModule, checkExpr };
