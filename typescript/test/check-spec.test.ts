import { join } from "path";
import { runAllCheckCases } from "./run-check-cases";

runAllCheckCases(join(import.meta.dir, "../../spec/cases/check"));
