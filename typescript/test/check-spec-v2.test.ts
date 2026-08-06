import { join } from "path";
import { runAllCheckCases } from "./run-check-cases";

runAllCheckCases(join(import.meta.dir, "../../spec-v2/cases/check"), {
  standardBuiltinsPath: join(import.meta.dir, "../../spec-v2/builtins/builtins.json"),
});
