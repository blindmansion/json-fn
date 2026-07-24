// Check a single function body against its declared signature: build its Γ,
// then check its `$return` against the declared return type. Nested function

import type { JSONType } from "../types";
import type { EnvironmentContract } from "../environment/types";
import { linkModule } from "../module-linker";
import type { CallableTable, CallableTypeRuleRegistry } from "./builtin-types";
import { synthCallableCall } from "./builtin-rules";
import { CORE_CALLABLE_TYPE_RULES } from "./callable-rules";
import { buildModuleTypeScope, checkBody, synth } from "./checker";
import { nonContractiveDefinitions } from "./type-defs";
import {
  EMPTY_ENV,
  isBody,
  report,
  reportDegradation,
  sigOf,
  stableStringify,
  type CheckContext,
  type Diagnostic,
  type Sig,
} from "./context";
import { collectSchemaRefs, type Defs, isSchemaObject, type Schema } from "../schema/schema.ts";

// Options controlling optional (soft-rollout) module lints.
type CheckModuleOptions = {
  // §9 / recenter §1.3: require every *top-level* function binding to carry a
  // `$sig`. Nested helpers and inline lambdas stay tolerant (they degrade to
  // `any`). On by default — an untyped top-level function is walked without a
  // meaningful contract (`any` params and return mask real errors), which is
  // exactly the silent degradation this pass exists to kill. Pass `false` (CLI:
  // `--allow-untyped-functions`) for the soft-rollout escape hatch.
  requireTypedModuleFunctions?: boolean;
  // Omitted installs the implementation's core rules. Supplying a registry is
  // explicit and uses it as-is; compose core and host rules before passing it.
  typeRules?: CallableTypeRuleRegistry;
  // The sole operator-owned package: named types, direct callable contracts,
  // effects, and the required module entry.
  contract?: EnvironmentContract;
};

type CheckExprOptions = {
  typeRules?: CallableTypeRuleRegistry;
  contract?: EnvironmentContract;
};

// Public entry, mirroring `callProgram`: lift `$types` into the defs pool, wire
// the module scope (function `$fnType`s eager, constants lazy), then check each
// function body. Returns all accumulated diagnostics.
function checkModule(
  module: Record<string, JSONType>,
  builtins?: CallableTable,
  options: CheckModuleOptions = {},
): Diagnostic[] {
  const contract = options.contract;
  const linked = linkModule({
    module,
    builtins: builtins ?? false,
    contract,
    validateEntry: false,
  });
  const moduleDefs = linked.moduleDefinitions;
  const defs = linked.definitions as Defs;
  const ctx: CheckContext = {
    defs,
    env: EMPTY_ENV,
    diagnostics: [],
    path: [],
    callables: linked.callableTable?.builtins,
    synthCallableCall,
    typeRules: options.typeRules ?? CORE_CALLABLE_TYPE_RULES,
    effects: contract?.effects,
  };
  let checkingModule = linked.module as Record<string, JSONType>;
  let entrySig: Sig | undefined;
  if (contract !== undefined) {
    const entryName = linked.entryName!;
    const body = module[entryName];
    if (body === undefined || !isBody(body)) {
      report(
        { ...ctx, path: [entryName] },
        `contract entry "${entryName}" is not a function defined by the module`,
      );
    } else {
      entrySig = linked.entrySignature as Sig;
      checkingModule = { ...linked.module, [entryName]: { ...body, $sig: entrySig } };
    }
  }

  // Declare-before-use: a `$ref` to an undeclared type name would otherwise
  // resolve to top (`resolveRef`), so a typo like `-> Reprot` checks clean.
  // The contract-owned entry signature replaces any guest annotation before
  // this walk; the guest copy is not part of the entry contract.
  checkDanglingRefs(checkingModule, defs, ctx);
  const nonContractive = nonContractiveDefinitions(Object.keys(moduleDefs), defs);
  for (const name of nonContractive) {
    report({ ...ctx, path: ["$types", name] }, `type declaration "${name}" is non-contractive`);
  }
  // Unsafe aliases can make ordinary checking recurse forever or overflow
  // before another useful diagnostic is produced.
  if (nonContractive.length > 0) return dedupeDiagnostics(ctx.diagnostics);

  const scopeModule = withoutTypes(checkingModule);
  const { env, guards } = buildModuleTypeScope(scopeModule, ctx);
  ctx.env = env;
  ctx.guards = guards;

  for (const key of Object.keys(scopeModule)) {
    const val = checkingModule[key]!;
    if (isBody(val)) {
      // §9: top-level functions must be fully typed (on by default). A missing
      // `$sig` is reported here rather than in the parser, which lacks module
      // context.
      const injectedSig = linked.entryName === key ? entrySig : undefined;
      if (sigOf(val) === null && injectedSig === undefined) {
        if (options.requireTypedModuleFunctions !== false) {
          report(
            { ...ctx, path: [key] },
            "module-level function must declare a signature (typed parameters and return)",
          );
        } else {
          reportDegradation(
            { ...ctx, path: [key] },
            `module function "${key}" has no declared signature`,
          );
        }
      }
      checkBody(val, { ...ctx, env, path: [key] }, injectedSig);
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

// Declare-before-use pass: report every `$ref` (reachable from the module)
// whose target name is absent from the merged defs pool. `$ref`s live only in
// schema positions — the `$types` pool bodies and the `$sig` nodes on function
// bodies (top-level, nested under `$let`, and inline lambdas) — so we collect
// from those two sources rather than blindly scanning term data. A name present
// in the pool but resolving to `true`/`any` (the intentional `type X = any`
// alias) is *not* flagged: only undefined names error.
function checkDanglingRefs(module: Record<string, JSONType>, defs: Defs, ctx: CheckContext): void {
  const types = isSchemaObject(module.$types) ? module.$types : {};
  for (const name of Object.keys(types)) {
    reportMissingRefs(types[name]!, ["$types", name], defs, ctx);
  }
  walkSigRefs(withoutTypes(module), [], defs, ctx);
}

// Collect the `$ref`s in a single schema and report each undefined target at
// `path`.
function reportMissingRefs(schema: Schema, path: string[], defs: Defs, ctx: CheckContext): void {
  const names = new Set<string>();
  collectSchemaRefs(schema, names);
  for (const name of names) {
    if (!(name in defs)) {
      report({ ...ctx, path }, `reference to undefined type "${name}"`);
    }
  }
}

// Walk the term tree looking for `$sig` nodes, checking each signature's
// required/optional/rest/return schemas for dangling `$ref`s. `$raw` payloads are verbatim
// data (no annotations), so they are not descended into.
function walkSigRefs(node: JSONType, path: string[], defs: Defs, ctx: CheckContext): void {
  if (Array.isArray(node)) {
    node.forEach((el, i) => walkSigRefs(el, [...path, String(i)], defs, ctx));
    return;
  }
  if (!isSchemaObject(node)) return;
  if ("$raw" in node) return;

  const sig = node.$sig;
  if (isSchemaObject(sig)) {
    const sigPath = [...path, "$sig"];
    const required = Array.isArray(sig.required) ? sig.required : [];
    const optional = Array.isArray(sig.optional) ? sig.optional : [];
    for (const p of [...required, ...optional]) reportMissingRefs(p, sigPath, defs, ctx);
    if ("rest" in sig && sig.rest !== undefined) reportMissingRefs(sig.rest, sigPath, defs, ctx);
    if ("returns" in sig && sig.returns !== undefined) {
      reportMissingRefs(sig.returns, sigPath, defs, ctx);
    }
  }

  for (const key of Object.keys(node)) {
    if (key === "$sig") continue; // schemas, already handled above
    walkSigRefs(node[key]!, [...path, key], defs, ctx);
  }
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
  builtins?: CallableTable,
  options: CheckExprOptions = {},
): { type: Schema; diagnostics: Diagnostic[] } {
  const contract = options.contract;
  const linked = linkModule({
    module: Object.keys(defs).length === 0 ? {} : { $types: defs },
    builtins: builtins ?? false,
    contract,
    validateEntry: false,
  });
  const ctx: CheckContext = {
    defs: linked.definitions as Defs,
    env: EMPTY_ENV,
    diagnostics: [],
    path: [],
    callables: linked.callableTable?.builtins,
    synthCallableCall,
    typeRules: options.typeRules ?? CORE_CALLABLE_TYPE_RULES,
    effects: contract?.effects,
  };
  return { type: synth(expr, ctx), diagnostics: ctx.diagnostics };
}

export { checkModule, checkExpr };
export type { CheckModuleOptions, CheckExprOptions };
