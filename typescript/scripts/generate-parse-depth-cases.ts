import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { JSONType } from "../src/types";

const fixturePath = join(import.meta.dir, "../../spec/cases/parse/structural-depth.json");
const MAX_DEPTH = 512;
const DEPTH_ERROR = `Maximum structural depth of ${MAX_DEPTH} exceeded`;

type FixtureCase = {
  description: string;
  source: string;
  comment?: string;
  expected?: JSONType;
  error?: string;
};

type FixtureSuite = {
  $schema: string;
  description: string;
  cases: FixtureCase[];
};

const generatedDescriptions = new Set([
  "arrays nested exactly to the limit are accepted",
  "inferred $raw output exactly at the produced-tree limit is accepted",
  "inferred $raw output one past the produced-tree limit is rejected",
]);

const suite = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureSuite;
suite.cases = suite.cases.filter(({ description }) => !generatedDescriptions.has(description));

const arrayRejection = caseIndex("arrays nested one past the limit are rejected");
suite.cases.splice(arrayRejection, 0, {
  description: "arrays nested exactly to the limit are accepted",
  source: nestedArraySource(MAX_DEPTH),
  expected: nestedArray(MAX_DEPTH),
});

const objectRejection = caseIndex("objects nested one past the limit are rejected");
const rawArrayDepth = MAX_DEPTH - 2;
suite.cases.splice(
  objectRejection,
  0,
  {
    description: "inferred $raw output exactly at the produced-tree limit is accepted",
    comment:
      "The quoted $-key object and inferred $raw wrapper consume two container levels, leaving 510 array levels.",
    source: nestedArraySource(rawArrayDepth, '{ "$x": 1 }'),
    expected: { $raw: nestedArray(rawArrayDepth, { $x: 1 }) },
  },
  {
    description: "inferred $raw output one past the produced-tree limit is rejected",
    comment: "511 arrays plus the quoted $-key object and inferred $raw wrapper produce depth 513.",
    source: nestedArraySource(rawArrayDepth + 1, '{ "$x": 1 }'),
    error: DEPTH_ERROR,
  },
);

writeFileSync(fixturePath, `${JSON.stringify(suite)}\n`);

function caseIndex(description: string): number {
  const index = suite.cases.findIndex((testCase) => testCase.description === description);
  if (index < 0) throw new Error(`Missing anchor case: ${description}`);
  return index;
}

function nestedArray(depth: number, leaf: JSONType = 1): JSONType {
  let value = leaf;
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

function nestedArraySource(depth: number, leaf = "1"): string {
  return `${"[".repeat(depth)}${leaf}${"]".repeat(depth)}`;
}
