import type {
  DefaultedField,
  DefaultedParam,
  FieldPattern,
  FunctionBody,
  FunctionCaptures,
  FunctionRegistry,
  JSONType,
} from "../types";
import { boundParameterNames, defaultBindings, requireParameterLayout } from "../params";
import { getOwnProperty, setOwnProperty } from "../own-properties";
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
  expression: FunctionBody,
  getVar: (name: string) => JSONType | undefined,
  localFns: ReadonlySet<string>,
  attachFns: ReadonlySet<string>,
  localFnDefs: FunctionRegistry | undefined,
  context: EvaluationContext,
): FunctionBody;
export function replaceVars(
  expression: JSONType,
  getVar: (name: string) => JSONType | undefined,
  localFns: ReadonlySet<string>,
  attachFns: ReadonlySet<string>,
  localFnDefs: FunctionRegistry | undefined,
  context: EvaluationContext,
): JSONType;
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

    if (
      "$let" in expression &&
      "$in" in expression &&
      typeof expression.$let === "object" &&
      expression.$let !== null &&
      !Array.isArray(expression.$let)
    ) {
      const bindings = expression.$let as Record<string, JSONType>;
      const names = new Set(Object.keys(bindings));
      const maskedGetVar = (name: string) => (names.has(name) ? undefined : getVar(name));
      const maskedAttachFns = new Set([...attachFns].filter((name) => !names.has(name)));
      const scopedLocalFns = new Set(localFns);
      for (const [name, value] of Object.entries(bindings)) {
        if (isFunctionBody(value)) scopedLocalFns.add(name);
      }
      const newBindings: Record<string, JSONType> = {};
      for (const [name, value] of Object.entries(bindings)) {
        setOwnProperty(
          newBindings,
          name,
          replaceVars(value, maskedGetVar, scopedLocalFns, maskedAttachFns, localFnDefs, context),
        );
      }
      return {
        $let: newBindings,
        $in: replaceVars(
          expression.$in as JSONType,
          maskedGetVar,
          scopedLocalFns,
          maskedAttachFns,
          localFnDefs,
          context,
        ),
      };
    }

    if (isFunctionBody(expression)) {
      const layout = requireParameterLayout(expression.$params, expression);
      const localNames = new Set(boundParameterNames(layout));
      const captures =
        expression.$captures !== undefined &&
        expression.$captures !== null &&
        typeof expression.$captures === "object" &&
        !Array.isArray(expression.$captures)
          ? expression.$captures
          : undefined;
      if (captures !== undefined) {
        for (const name of Object.keys(captures)) localNames.add(name);
      }
      const scopedLocalFns = new Set(localFns);
      for (const name of Object.keys(captures ?? {})) scopedLocalFns.add(name);

      const maskedGetVar =
        localNames.size > 0
          ? (name: string) => (localNames.has(name) ? undefined : getVar(name))
          : getVar;

      const newObject: FunctionBody = { ...expression };
      if (expression.$params !== undefined) {
        const params = [...expression.$params];
        for (const slot of layout.slots) {
          if (slot.kind === "defaulted") {
            params[slot.index] = {
              ...(params[slot.index] as DefaultedParam),
              $default: replaceVars(
                slot.defaultExpression,
                maskedGetVar,
                scopedLocalFns,
                attachFns,
                localFnDefs,
                context,
              ),
            };
            continue;
          }
          if (slot.kind !== "fields") continue;
          const pattern = params[slot.index] as FieldPattern;
          const fields = [...pattern.$fields];
          for (const binding of slot.bindings) {
            if (binding.kind !== "defaulted") continue;
            fields[binding.fieldIndex] = {
              ...(fields[binding.fieldIndex] as DefaultedField),
              $default: replaceVars(
                binding.defaultExpression,
                maskedGetVar,
                scopedLocalFns,
                attachFns,
                localFnDefs,
                context,
              ),
            };
          }
          params[slot.index] = { $fields: fields };
        }
        newObject.$params = params;
      }
      newObject.$return = replaceVars(
        expression.$return,
        maskedGetVar,
        scopedLocalFns,
        attachFns,
        localFnDefs,
        context,
      );
      if (captures !== undefined) {
        const newCaptures: FunctionCaptures = {};
        for (const [name, definition] of Object.entries(captures)) {
          setOwnProperty(
            newCaptures,
            name,
            replaceVars(definition, maskedGetVar, scopedLocalFns, attachFns, localFnDefs, context),
          );
        }
        newObject.$captures = newCaptures;
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
    // parameters and captures are masked out of `getVar` upstream, so only free lexical
    // bindings of *enclosing* scopes are captured.
    if ("$call" in expression) {
      const callee = expression.$call;
      let newCallee: JSONType = callee;
      if (typeof callee === "string") {
        if (!localFns.has(callee)) {
          const captured = getVar(callee);
          if (captured !== undefined && isFunctionDeclaration(captured)) newCallee = captured;
        }
      } else {
        newCallee = replaceVars(callee, getVar, localFns, attachFns, localFnDefs, context);
      }
      const args = expression.$args;
      const newArgs = Array.isArray(args)
        ? args.map((item) => replaceVars(item, getVar, localFns, attachFns, localFnDefs, context))
        : args!;
      return { ...expression, $call: newCallee, $args: newArgs };
    }

    const newObject: Record<string, JSONType> = {};
    for (const [key, value] of Object.entries(expression)) {
      setOwnProperty(
        newObject,
        key,
        replaceVars(value, getVar, localFns, attachFns, localFnDefs, context),
      );
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
  blocked: ReadonlySet<string> = new Set(),
): void {
  if (node === null || typeof node !== "object") return;
  if (isRaw(node)) return;
  if (Array.isArray(node)) {
    for (const item of node) collectFnNameRefs(item, filter, out, blocked);
    return;
  }
  if (isFunctionBody(node)) return;

  if (
    "$let" in node &&
    "$in" in node &&
    typeof node.$let === "object" &&
    node.$let !== null &&
    !Array.isArray(node.$let)
  ) {
    const letBlocked = new Set(blocked);
    for (const name of Object.keys(node.$let)) letBlocked.add(name);
    for (const value of Object.values(node.$let)) {
      collectFnNameRefs(value, filter, out, letBlocked);
    }
    collectFnNameRefs(node.$in as JSONType, filter, out, letBlocked);
    return;
  }

  if ("$call" in node) {
    const callee = (node as Record<string, JSONType>).$call!;
    if (typeof callee === "string") {
      if (!blocked.has(callee) && (filter === null || filter.has(callee))) out.add(callee);
    } else collectFnNameRefs(callee, filter, out, blocked);
    const args = (node as Record<string, JSONType>).$args;
    if (Array.isArray(args)) {
      for (const item of args) collectFnNameRefs(item, filter, out, blocked);
    }
    return;
  }
  const fnValue = (node as Record<string, JSONType>).$fn;
  if (typeof fnValue === "string") {
    if (!blocked.has(fnValue) && (filter === null || filter.has(fnValue))) out.add(fnValue);
    return;
  }
  for (const value of Object.values(node)) collectFnNameRefs(value, filter, out, blocked);
}

// Scan a function body's parameter defaults, `$return`, and serialized capture
// definitions for referenced function names.
function scanBodyLevelFnNameRefs(
  body: Record<string, JSONType>,
  filter: ReadonlySet<string> | null,
  out: Set<string>,
  visited: WeakSet<object> = new WeakSet(),
): void {
  if (visited.has(body)) return;
  visited.add(body);
  const layout = requireParameterLayout(body.$params, body);
  const captures =
    body.$captures !== undefined &&
    body.$captures !== null &&
    typeof body.$captures === "object" &&
    !Array.isArray(body.$captures)
      ? body.$captures
      : undefined;
  const blocked = new Set(boundParameterNames(layout));
  for (const name of Object.keys(captures ?? {})) blocked.add(name);
  for (const binding of defaultBindings(layout)) {
    collectFnNameRefs(binding.expression, filter, out, blocked);
  }
  collectFnNameRefs(body.$return!, filter, out, blocked);
  for (const definition of Object.values(captures ?? {})) {
    if (isFunctionBody(definition)) {
      scanBodyLevelFnNameRefs(definition as Record<string, JSONType>, filter, out, visited);
    }
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
// Iterative: attached definitions can embed substituted runtime values of any
// depth (they are inert for evaluation but still get counted here), so a
// recursive walk could exhaust the host stack.
function countNodes(node: JSONType): number {
  let count = 0;
  const stack: JSONType[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    count++;
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else {
      for (const value of Object.values(current)) stack.push(value);
    }
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
// definition under `$captures`. Only `attachFns` names are eligible —
// registry-backed module functions are deliberately excluded (see
// `attachFns` in types.ts). Definitions come from `localFnDefs` (the scope's
// closed-over registry) rather than `getVar`, so mutually recursive clusters
// do not trip the lazy-`$var` cycle detector. The walk is transitive (an
// attached function pulls in the siblings it calls) and cycle-safe (names
// already present are skipped). Names bound by this body's parameters and
// captures are never attached, preserving shadowing. Each attached definition
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

  const existingCaptures =
    body.$captures !== null && typeof body.$captures === "object" && !Array.isArray(body.$captures)
      ? (body.$captures as Record<string, JSONType>)
      : {};
  const capturedNames = new Set(Object.keys(existingCaptures));
  let attachedNodes = 0;
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (capturedNames.has(name) || boundNames.has(name)) continue;
    const definition = getOwnProperty(localFnDefs, name);
    if (!isFunctionBody(definition)) {
      continue;
    }
    // Meter the attachment (Part B safety net): charge and size-guard before
    // embedding, so an unexpectedly large or growing capture raises a clean
    // limit error rather than silently ballooning.
    attachedNodes += cachedCountNodes(definition);
    guardValueSize(context, attachedNodes);
    chargeFuel(context, attachedNodes);
    setOwnProperty(existingCaptures, name, definition as JSONType);
    capturedNames.add(name);
    for (const reference of cachedBodyLevelFnNameRefs(definition as Record<string, JSONType>)) {
      if (
        attachFns.has(reference) &&
        !capturedNames.has(reference) &&
        !boundNames.has(reference) &&
        !seen.has(reference)
      ) {
        seen.add(reference);
        queue.push(reference);
      }
    }
  }
  if (capturedNames.size > 0) body.$captures = existingCaptures;
}
