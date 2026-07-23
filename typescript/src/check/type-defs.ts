import {
  SchemaKind,
  classifySchema,
  fixedParamSchemas,
  fnShape,
  isSchemaObject,
  refName,
  taskCompletion,
  unionArms,
  type Defs,
  type Schema,
} from "../schema/schema.ts";

// Collect references reachable without crossing an array or object constructor.
// Contractive recursion is precisely the absence of a cycle in this unguarded
// reference graph: unions, function types, and Task are transparent, while
// arrays (including tuples) and objects guard every type nested beneath them.
function collectUnguardedRefs(schema: Schema, into: Set<string>): void {
  if (!isSchemaObject(schema)) return;
  switch (classifySchema(schema)) {
    case SchemaKind.Ref:
      into.add(refName(schema));
      return;
    case SchemaKind.Union:
      for (const arm of unionArms(schema) ?? []) collectUnguardedRefs(arm, into);
      return;
    case SchemaKind.FnType: {
      const shape = fnShape(schema);
      for (const param of fixedParamSchemas(shape)) collectUnguardedRefs(param, into);
      if (shape.rest !== undefined) collectUnguardedRefs(shape.rest, into);
      collectUnguardedRefs(shape.returns, into);
      return;
    }
    case SchemaKind.TaskType:
      collectUnguardedRefs(taskCompletion(schema), into);
      return;
    case SchemaKind.Array:
    case SchemaKind.Tuple:
    case SchemaKind.Object:
      return;
    default:
      return;
  }
}

function unguardedEdges(schema: Schema): Set<string> {
  const refs = new Set<string>();
  collectUnguardedRefs(schema, refs);
  return refs;
}

// A declaration is non-contractive when following one or more unguarded aliases
// can return to that declaration. The visited set makes malformed pools safe to
// inspect and still permits a path to the root to be recognized as a cycle.
function isNonContractive(name: string, defs: Defs): boolean {
  const visited = new Set<string>();
  const pending = [...unguardedEdges(defs[name]!)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === name) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const definition = defs[current];
    if (definition !== undefined) pending.push(...unguardedEdges(definition));
  }
  return false;
}

function nonContractiveDefinitions(names: string[], defs: Defs): string[] {
  return names.filter((name) => defs[name] !== undefined && isNonContractive(name, defs));
}

export { nonContractiveDefinitions };
