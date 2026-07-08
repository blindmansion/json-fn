import type { Defs, Schema } from "./schema";

type TVarNode = { $tvar: string };
type BuiltinSig = { typeParams?: string[]; params: Schema[]; rest?: Schema; returns: Schema };
type BuiltinEntry = BuiltinSig[] | { rule: string };
type BuiltinTable = { $defs?: Defs; builtins: Record<string, BuiltinEntry> };

// A per-call-site type-variable environment (T, U, … → their inferred schema).
type Bindings = Record<string, Schema>;

export type { TVarNode, BuiltinSig, BuiltinEntry, BuiltinTable, Bindings };
