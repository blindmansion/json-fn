import { runAllParseCases } from "./run-parse-cases";
import { join } from "path";

runAllParseCases(join(import.meta.dir, "../../spec/parse-cases"));
