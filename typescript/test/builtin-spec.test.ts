import { join } from "path";
import { runAllBuiltinCases } from "./run-builtin-cases";

runAllBuiltinCases(join(import.meta.dir, "../../spec/cases/builtins"));
