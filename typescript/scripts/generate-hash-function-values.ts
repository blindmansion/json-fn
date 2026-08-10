/**
 * One-shot generator for `spec-v2/cases/hash/function-values.json`. Values
 * are authored here; `canonical` and `valueHash` are computed by the
 * canonical JSON encoder and reviewed against `docs/runtime/hashing.md`
 * before the vectors are committed. Other implementations consume the
 * committed JSON file. Function values are ordinary values to the encoder:
 * no vector here exercises a rule the base suites do not already pin — what
 * these pin is the exact canonical bytes of record-carrying shapes.
 */
import { join } from "path";
import { canonicalJsonText, valueHash } from "../src/hashing";

type VectorCase = { name: string; value: unknown };

// The curried-add inner body: `(y) => x + y` with `x` free.
const curriedInnerBody = {
  $params: ["y"],
  $return: { $call: "add", $args: [{ $var: "x" }, { $var: "y" }] },
};

// The countdown body: `(x) => if x <= 0 then base else go(x - 1)`, with
// `base` a value-position free name and `go` a call-position self-reference.
const countdownBody = {
  $params: ["x"],
  $return: {
    $if: { $call: "lte", $args: [{ $var: "x" }, 0] },
    $then: { $var: "base" },
    $else: { $call: "go", $args: [{ $call: "sub", $args: [{ $var: "x" }, 1] }] },
  },
};

// Mutual group: `isEven` calls `isOdd`; `isOdd` reads `limit` and calls
// `isEven`.
const isEvenBody = {
  $params: ["n"],
  $return: {
    $if: { $call: "eq", $args: [{ $var: "n" }, 0] },
    $then: true,
    $else: { $call: "isOdd", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
  },
};
const isOddBody = {
  $params: ["n"],
  $return: {
    $if: { $call: "gt", $args: [{ $var: "n" }, { $var: "limit" }] },
    $then: false,
    $else: {
      $if: { $call: "eq", $args: [{ $var: "n" }, 0] },
      $then: false,
      $else: { $call: "isEven", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
    },
  },
};

const description =
  "Function values hash under jfn:value:v1 as the ordinary values they are: the body subtree encodes byte-identical to the normalized source body, the capture record is plain object data under canonical key ordering, and an empty record is omitted";

const cases: VectorCase[] = [
  {
    name: "a body with no free variables carries no record: the value encodes identically to its source body",
    value: {
      $params: ["y"],
      $return: { $call: "mul", $args: [{ $var: "y" }, 2] },
    },
  },
  {
    name: "curried add: the inner source body, with x free",
    value: curriedInnerBody,
  },
  {
    name: "simple value capture: the same body applied with x = 10; the $params and $return subtrees encode byte-identical to the source-body vector",
    value: { ...curriedInnerBody, $captures: { x: 10 } },
  },
  {
    name: "a captured value with call-shaped keys is inert record data and hashes as the exact structure it is",
    value: {
      $return: { $var: "x" },
      $captures: { x: { $call: "add", $args: [1, 2] } },
    },
  },
  {
    name: "nested closure: a record entry that is itself a record-carrying function value",
    value: {
      $params: ["y"],
      $return: { $call: "f", $args: [{ $var: "y" }] },
      $captures: { f: { ...curriedInnerBody, $captures: { x: 10 } } },
    },
  },
  {
    name: "self-recursive escape: an open-body self entry beside a captured value; open bodies carry no records of their own",
    value: {
      ...countdownBody,
      $captures: { base: 42, go: countdownBody },
    },
  },
  {
    name: "mutual group: one open-body entry per member reached in call position, plus the group's one captured value",
    value: {
      ...isEvenBody,
      $captures: { isEven: isEvenBody, isOdd: isOddBody, limit: 100 },
    },
  },
  {
    name: "the record scopes over parameter defaults: a $default expression reading a record entry rides the value unrewritten",
    value: {
      $params: ["score", { $param: "boost", $default: { $var: "bonus" } }],
      $return: { $call: "add", $args: [{ $var: "score" }, { $var: "boost" }] },
      $captures: { bonus: 5 },
    },
  },
  {
    name: "typed slots and a return annotation are part of the value's bytes and participate in its address",
    value: {
      $params: [{ $param: "amount", $type: { type: "number" } }],
      $returns: { type: "number" },
      $return: { $call: "mul", $args: [{ $var: "amount" }, { $var: "rate" }] },
      $captures: { rate: 0.2 },
    },
  },
];

const entries = cases.map(({ name, value }) => ({
  name,
  value,
  canonical: canonicalJsonText(value),
  valueHash: valueHash(value),
}));

const outPath = join(import.meta.dir, "../../spec-v2/cases/hash/function-values.json");
await Bun.write(outPath, `${JSON.stringify({ description, cases: entries }, null, 2)}\n`);
console.log(`wrote spec-v2/cases/hash/function-values.json (${entries.length} cases)`);
