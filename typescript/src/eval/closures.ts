import type { FunctionRegistry, JSONType } from "../types";
import { CONTRACT_KEY } from "../runtime-contract";
import { boundParameterNames, defaultBindings, requireParameterLayout } from "../params";
import { isRaw, raw } from "../utils";
import { isFunctionBody, isFunctionDeclaration } from "../function-value";
import { chargeFuel, guardValueSize } from "./execution";
import type { EvaluationContext } from "./internal-types";

// Closure capture. Substitutes free `$var`s and captures function-valued
// callees, and — when `localFnDefs` is supplied ("attach mode") — makes an
// escaping function body self-contained by re-attaching the enclosing local
// functions it still references by name (see `attachFreeLocalFns`). Attach mode
// is off while the interpreter closes over local functions for *in-scope*
// registry dispatch: those must keep sibling names literal, and `localFnDefs`
// is exactly the set of closed-over bodies produced there.
export function replaceVars(
  expression: JSONType,
  getVar: (name: string) => JSONType | undefined,
  localFns: ReadonlySet<string>,
  attachFns: ReadonlySet<string>,
  localFnDefs: FunctionRegistry | undefined,
  context: EvaluationContext,
): JSONType {
  const { perf } = context;
  if (perf) perf.replaceVars++;
  if (typeof expression === "object" && expression !== null && isRaw(expression)) {
    if (perf) perf.rawSkips++;
    return expression;
  }
  if (Array.isArray(expression)) {
    return expression.map((item) =>
      replaceVars(item, getVar, localFns, attachFns, localFnDefs, context),
    );
  }

  if (typeof expression === "object" && expression !== null) {
    if ("$var" in expression && typeof expression.$var === "string") {
      const varValue = getVar(expression.$var);
      if (varValue === undefined) return expression;
      // Substitution moves an already-evaluated value into expression
      // position. Mark data values so they remain inert there, including host
      // objects whose keys happen to look like expression syntax. Function
      // declarations stay live for nested capture and attachment.
      if (typeof varValue === "object" && varValue !== null && !isFunctionDeclaration(varValue)) {
        raw(varValue);
      }
      return varValue;
    }

    if (isFunctionBody(expression)) {
      const localNames = new Set(
        Object.keys(expression).filter((key) => {
          if (
            key === "$return" ||
            key === "$params" ||
            key === "$sig" ||
            key === "$types" ||
            key === CONTRACT_KEY
          ) {
            return false;
          }
          if (
            key === "$comment" &&
            typeof (expression as Record<string, JSONType>)[key] === "string"
          ) {
            return false;
          }
          return true;
        }),
      );

      const layout = requireParameterLayout(expression.$params, expression);
      for (const name of boundParameterNames(layout)) localNames.add(name);

      const maskedGetVar =
        localNames.size > 0
          ? (name: string) => (localNames.has(name) ? undefined : getVar(name))
          : getVar;

      const newObject: Record<string, JSONType> = {};
      for (const [key, value] of Object.entries(expression)) {
        newObject[key] = replaceVars(
          value,
          maskedGetVar,
          localFns,
          attachFns,
          localFnDefs,
          context,
        );
      }
      // Re-attach the enclosing local functions this escaping body still calls
      // by name, so it stays callable once it leaves its defining scope. Off
      // during in-scope close-over (localFnDefs undefined), where sibling names
      // must remain literal for registry dispatch. Only *attachable* names are
      // considered (`attachFns`): registry-backed module functions are excluded,
      // since they resolve by name for the program's lifetime and inlining a
      // self-referential one blows capture up (see `attachFns` in types.ts).
      if (localFnDefs !== undefined && attachFns.size > 0) {
        attachFreeLocalFns(newObject, localNames, attachFns, localFnDefs, context);
      }
      return newObject;
    }

    // FunctionCall: capture a free callee identifier into the closure, mirroring
    // $var capture above. A bare-identifier callee lowers to a literal registry
    // name, so a combinator's function argument (e.g. `f` in `twice`/`compose`)
    // or a shadowing parameter (a param named like a stdlib builtin) would be
    // lost once the inner lambda escapes the defining scope.
    //
    // P4/Site 2 (Option A): capture when the callee resolves via `getVar` to a
    // function declaration *and* it is not a scoped local function name. Local
    // function names stay literal so they keep dispatching through the registry
    // (recursion/mutual-recursion are preserved). The current body's own
    // params/locals are masked out of `getVar` upstream, so only free lexical
    // bindings of *enclosing* scopes are captured.
    if ("$call" in expression) {
      const callee = (expression as Record<string, JSONType>).$call!;
      let newCallee: JSONType = callee;
      if (typeof callee === "string") {
        if (!localFns.has(callee)) {
          const captured = getVar(callee);
          if (captured !== undefined && isFunctionDeclaration(captured)) newCallee = captured;
        }
      } else {
        newCallee = replaceVars(callee, getVar, localFns, attachFns, localFnDefs, context);
      }
      const args = (expression as Record<string, JSONType>).$args;
      const newArgs = Array.isArray(args)
        ? args.map((item) => replaceVars(item, getVar, localFns, attachFns, localFnDefs, context))
        : args!;
      return { ...expression, $call: newCallee, $args: newArgs };
    }

    const newObject: Record<string, JSONType> = {};
    for (const [key, value] of Object.entries(expression)) {
      newObject[key] = replaceVars(value, getVar, localFns, attachFns, localFnDefs, context);
    }
    return newObject;
  }

  return expression;
}

// Collect every function name referenced by `node` at its own scope level, in
// call position (`{ $call: "name", $args: [...] }`) or as a function reference
// (`{ $fn: "name" }`). Nested function bodies are scope boundaries: they are
// skipped here because they re-attach their own free local functions when they
// are themselves captured. `$var`-position references to local functions are
// already inlined by `replaceVars`, so they never reach this scan as names.
// With `filter` null the collection is unfiltered (all names) so the result is
// a property of the node alone and can be cached by identity; with a filter
// set, only matching names are collected (used for one-shot scans of freshly
// built bodies, where a smaller result set is cheaper than caching).
function collectFnNameRefs(
  node: JSONType,
  filter: ReadonlySet<string> | null,
  out: Set<string>,
): void {
  if (node === null || typeof node !== "object") return;
  if (isRaw(node)) return;
  if (Array.isArray(node)) {
    for (const item of node) collectFnNameRefs(item, filter, out);
    return;
  }
  if (isFunctionBody(node)) return;

  if ("$call" in node) {
    const callee = (node as Record<string, JSONType>).$call!;
    if (typeof callee === "string") {
      if (filter === null || filter.has(callee)) out.add(callee);
    } else collectFnNameRefs(callee, filter, out);
    const args = (node as Record<string, JSONType>).$args;
    if (Array.isArray(args)) {
      for (const item of args) collectFnNameRefs(item, filter, out);
    }
    return;
  }
  const fnValue = (node as Record<string, JSONType>).$fn;
  if (typeof fnValue === "string") {
    if (filter === null || filter.has(fnValue)) out.add(fnValue);
    return;
  }
  for (const value of Object.values(node)) collectFnNameRefs(value, filter, out);
}

// Scan a function body's own level (its `$return`, locals, and parameter
// defaults — not nested lambdas) for referenced function names.
function scanBodyLevelFnNameRefs(
  body: Record<string, JSONType>,
  filter: ReadonlySet<string> | null,
  out: Set<string>,
): void {
  const layout = requireParameterLayout(body.$params, body);
  for (const binding of defaultBindings(layout)) {
    collectFnNameRefs(binding.expression, filter, out);
  }
  for (const [key, value] of Object.entries(body)) {
    if (key === "$params") continue;
    if (key === "$sig" || key === "$types" || key === CONTRACT_KEY) continue;
    if (key === "$comment" && typeof value === "string") continue;
    collectFnNameRefs(value, filter, out);
  }
}

// Cache of body-level name references per function-body object. Closed-over
// local function definitions are stable objects reused across every escape
// from their scope, so without this cache `attachFreeLocalFns` re-scans each
// definition once per escaping closure (quadratic in escapes x definitions).
// Only stable definition objects go through this; freshly-built escaping
// bodies use `scanBodyLevelFnNameRefs` directly since they can never hit.
const bodyFnNameRefsCache = new WeakMap<object, ReadonlySet<string>>();

function cachedBodyLevelFnNameRefs(body: Record<string, JSONType>): ReadonlySet<string> {
  const cached = bodyFnNameRefsCache.get(body);
  if (cached !== undefined) return cached;
  const out = new Set<string>();
  scanBodyLevelFnNameRefs(body, null, out);
  bodyFnNameRefsCache.set(body, out);
  return out;
}

// Count the JSON nodes in a value — used to meter escaping-closure attachment
// so a runaway capture fails against the value-size/fuel limits instead of
// hanging (the safety net for pathological but bounded capture growth).
function countNodes(node: JSONType): number {
  if (node === null || typeof node !== "object") return 1;
  let count = 1;
  if (Array.isArray(node)) {
    for (const item of node) count += countNodes(item);
  } else {
    for (const value of Object.values(node)) count += countNodes(value);
  }
  return count;
}

// Memoized at the top-level definition only (not per inner node), for the same
// reason as `bodyFnNameRefsCache`: an attached definition is a stable object
// re-counted once per escaping closure otherwise.
const nodeCountCache = new WeakMap<object, number>();

function cachedCountNodes(node: object): number {
  const cached = nodeCountCache.get(node);
  if (cached !== undefined) return cached;
  const count = countNodes(node as JSONType);
  nodeCountCache.set(node, count);
  return count;
}

// Make an escaping function body self-contained: for every enclosing local
// function it still references by name (kept literal so recursion/mutual
// recursion dispatch through the scope), attach that function's closed-over
// definition as a sibling local. Only `attachFns` names are eligible —
// registry-backed module functions are deliberately excluded (see
// `attachFns` in types.ts). Definitions come from `localFnDefs` (the scope's
// closed-over registry) rather than `getVar`, so mutually recursive clusters
// do not trip the lazy-`$var` cycle detector. The walk is transitive (an
// attached function pulls in the siblings it calls) and cycle-safe (names
// already present are skipped). Names bound by this body — its own params and
// locals — are never attached, preserving shadowing. Each attached definition
// is charged to the fuel/value-size budget so runaway capture fails fast.
function attachFreeLocalFns(
  body: Record<string, JSONType>,
  boundNames: ReadonlySet<string>,
  attachFns: ReadonlySet<string>,
  localFnDefs: FunctionRegistry,
  context: EvaluationContext,
): void {
  const queue: string[] = [];
  const seen = new Set<string>();
  // The escaping body is freshly built for this escape, so scan it directly
  // (a cache entry for it could never be reused, and the body is mutated
  // below, which would leave a stale entry).
  scanBodyLevelFnNameRefs(body, attachFns, seen);
  queue.push(...seen);

  let attachedNodes = 0;
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (name in body || boundNames.has(name)) continue;
    const definition = localFnDefs[name];
    if (!isFunctionBody(definition)) {
      continue;
    }
    // Meter the attachment (Part B safety net): charge and size-guard before
    // embedding, so an unexpectedly large or growing capture raises a clean
    // limit error rather than silently ballooning.
    attachedNodes += cachedCountNodes(definition);
    guardValueSize(context, attachedNodes);
    chargeFuel(context, attachedNodes);
    body[name] = definition as JSONType;
    for (const reference of cachedBodyLevelFnNameRefs(definition as Record<string, JSONType>)) {
      if (
        attachFns.has(reference) &&
        !(reference in body) &&
        !boundNames.has(reference) &&
        !seen.has(reference)
      ) {
        seen.add(reference);
        queue.push(reference);
      }
    }
  }
}
