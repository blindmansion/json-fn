import { runAllCases } from "./run-cases";
import { join } from "path";

runAllCases(join(import.meta.dir, "../../spec/cases/eval"));
