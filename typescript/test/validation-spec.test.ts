import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  linkModule,
  prepareDeployment,
  validateDeploymentProfile,
  validateEnvironmentContract,
  validateSchemaFragment,
  type EnvironmentContract,
  type JSONType,
} from "../src";

type Expected = { valid: true } | { valid: false; code: string; path: string };
type ValidationCase = {
  name: string;
  validator: "schema" | "contract" | "profile" | "link" | "deployment";
  value?: unknown;
  contract?: EnvironmentContract;
  module?: Record<string, JSONType>;
  profile?: unknown;
  adapterFunctions?: string[];
  adapterEffects?: string[];
  expected: Expected;
};
type ValidationFile = { description: string; cases: ValidationCase[] };

const casesDirectory = join(import.meta.dir, "../../spec/validation-cases");
for (const path of new Bun.Glob("*.json").scanSync(casesDirectory)) {
  const suite = (await Bun.file(join(casesDirectory, path)).json()) as ValidationFile;
  describe(suite.description, () => {
    for (const item of suite.cases) {
      test(item.name, () => {
        const validate = (): void => {
          if (item.validator === "schema") {
            validateSchemaFragment(item.value);
          } else if (item.validator === "contract") {
            validateEnvironmentContract(item.value);
          } else if (item.validator === "profile") {
            validateDeploymentProfile(item.value, item.contract);
          } else if (item.validator === "link") {
            linkModule({
              module: item.module ?? {},
              contract: item.contract,
            });
          } else {
            prepareDeployment({
              module: item.module ?? {},
              contract: item.contract!,
              profile: item.profile as never,
              adapter: {
                functions: Object.fromEntries(
                  (item.adapterFunctions ?? []).map((name) => [name, () => null]),
                ),
                effects: Object.fromEntries(
                  (item.adapterEffects ?? []).map((name) => [name, () => null]),
                ),
              },
            });
          }
        };

        if (item.expected.valid) {
          expect(validate).not.toThrow();
          return;
        }

        try {
          validate();
          throw new Error("expected validation to fail");
        } catch (error) {
          expect(error).toMatchObject({
            code: item.expected.code,
            path: item.expected.path,
          });
        }
      });
    }
  });
}
