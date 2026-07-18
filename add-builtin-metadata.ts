/// <reference types="./typescript/node_modules/bun-types" />

export {};

type Metadata = {
  description: string;
  category: string;
};

const metadata = {
  add: { description: "Add two numbers.", category: "arithmetic" },
  sub: { description: "Subtract the second number from the first.", category: "arithmetic" },
  mul: { description: "Multiply two numbers.", category: "arithmetic" },
  mod: {
    description: "Return the remainder after division; throws when the divisor is zero.",
    category: "arithmetic",
  },
  div: {
    description: "Divide two numbers; throws when the divisor is zero.",
    category: "arithmetic",
  },
  neg: { description: "Negate a number.", category: "arithmetic" },
  abs: { description: "Return the absolute value of a number.", category: "arithmetic" },
  floor: { description: "Round a number down to the nearest integer.", category: "arithmetic" },
  ceil: { description: "Round a number up to the nearest integer.", category: "arithmetic" },
  round: { description: "Round a number to the nearest integer.", category: "arithmetic" },
  max: {
    description: "Return the largest number in a non-empty array.",
    category: "arithmetic",
  },
  min: {
    description: "Return the smallest number in a non-empty array.",
    category: "arithmetic",
  },
  sum: {
    description: "Sum an array of numbers, returning zero for an empty array.",
    category: "arithmetic",
  },
  sqrt: { description: "Return the square root of a number.", category: "arithmetic" },
  pow: { description: "Raise a base to an exponent.", category: "arithmetic" },

  eq: { description: "Test two values for structural equality.", category: "comparison" },
  neq: { description: "Test two values for structural inequality.", category: "comparison" },
  lt: {
    description: "Test whether the first number is less than the second.",
    category: "comparison",
  },
  lte: {
    description: "Test whether the first number is less than or equal to the second.",
    category: "comparison",
  },
  gt: {
    description: "Test whether the first number is greater than the second.",
    category: "comparison",
  },
  gte: {
    description: "Test whether the first number is greater than or equal to the second.",
    category: "comparison",
  },

  not: { description: "Return the logical negation of a boolean.", category: "logic" },
  and: { description: "Return the eager logical conjunction of two booleans.", category: "logic" },
  or: { description: "Return the eager logical disjunction of two booleans.", category: "logic" },

  isNull: { description: "Test whether a value is null.", category: "type-checking" },
  isBool: { description: "Test whether a value is a boolean.", category: "type-checking" },
  isNumber: { description: "Test whether a value is a number.", category: "type-checking" },
  isString: { description: "Test whether a value is a string.", category: "type-checking" },
  isArray: { description: "Test whether a value is an array.", category: "type-checking" },
  isObject: { description: "Test whether a value is a plain object.", category: "type-checking" },
  isTask: { description: "Test whether a value is a task.", category: "type-checking" },

  str: {
    description: "Convert a value to a string, serializing non-string values.",
    category: "coercion",
  },
  num: {
    description: "Convert a value to a number; throws when conversion fails.",
    category: "coercion",
  },

  upper: { description: "Convert a string to uppercase.", category: "strings" },
  lower: { description: "Convert a string to lowercase.", category: "strings" },
  trim: { description: "Remove whitespace from both ends of a string.", category: "strings" },
  strcat: { description: "Concatenate any number of strings.", category: "strings" },
  split: { description: "Split a string on a separator.", category: "strings" },
  join: { description: "Join an array's elements with a separator.", category: "strings" },
  startsWith: { description: "Test whether a string starts with a prefix.", category: "strings" },
  endsWith: { description: "Test whether a string ends with a suffix.", category: "strings" },
  replace: {
    description: "Replace all literal, non-overlapping occurrences of a non-empty search string.",
    category: "strings",
  },
  padStart: {
    description: "Left-pad a string to a Unicode code-point length.",
    category: "strings",
  },

  length: { description: "Return the length of an array or string.", category: "arrays" },
  head: {
    description: "Return the first element of an array, or null when empty.",
    category: "arrays",
  },
  last: {
    description: "Return the last element of an array, or null when empty.",
    category: "arrays",
  },
  tail: { description: "Return all but the first element of an array.", category: "arrays" },
  reverse: { description: "Return a reversed copy of an array.", category: "arrays" },
  take: { description: "Return the first requested number of array elements.", category: "arrays" },
  drop: {
    description: "Return an array without its first requested number of elements.",
    category: "arrays",
  },
  zip: {
    description: "Pair corresponding elements, stopping at the shorter array.",
    category: "arrays",
  },
  unique: {
    description: "Keep the first occurrence of each structurally distinct array value.",
    category: "arrays",
  },
  repeat: {
    description: "Repeat an array or string a non-negative number of times.",
    category: "arrays",
  },
  flatten: { description: "Flatten an array by one level.", category: "arrays" },
  concat: { description: "Concatenate any number of arrays.", category: "arrays" },
  range: {
    description: "Create an array of integers from zero up to, but excluding, an endpoint.",
    category: "arrays",
  },
  slice: { description: "Return a slice of an array or string.", category: "arrays" },
  includes: {
    description: "Test an array for a structurally equal value, or a string for a substring.",
    category: "arrays",
  },
  indexOf: {
    description:
      "Find a structurally equal array value or string substring, returning null when absent.",
    category: "arrays",
  },
  setAt: { description: "Return an array with one element replaced.", category: "arrays" },

  keys: { description: "Return an object's keys.", category: "objects" },
  values: { description: "Return an object's values.", category: "objects" },
  entries: { description: "Return an object's key-value pairs.", category: "objects" },
  fromEntries: { description: "Create an object from key-value pairs.", category: "objects" },
  merge: {
    description: "Shallowly merge two objects, with the second object's values winning conflicts.",
    category: "objects",
  },
  hasKey: { description: "Test whether an object contains a key.", category: "objects" },
  pick: { description: "Return an object containing selected keys.", category: "objects" },
  omit: { description: "Return an object excluding selected keys.", category: "objects" },

  map: { description: "Transform each array element with a callback.", category: "higher-order" },
  mapIndexed: {
    description: "Transform each array element with a callback that also receives its index.",
    category: "higher-order",
  },
  filter: {
    description: "Keep array elements for which a callback returns true.",
    category: "higher-order",
  },
  filterIndexed: {
    description: "Keep array elements using a callback that also receives each index.",
    category: "higher-order",
  },
  reduce: { description: "Fold an array into an accumulator.", category: "higher-order" },
  reduceIndexed: {
    description: "Fold an array with a callback that also receives each index.",
    category: "higher-order",
  },
  find: {
    description: "Return the first array element matching a callback, or null.",
    category: "higher-order",
  },
  findIndexed: {
    description: "Find an array element with a callback that also receives each index.",
    category: "higher-order",
  },
  findIndex: {
    description: "Return the index of the first callback match, or null.",
    category: "higher-order",
  },
  findIndexIndexed: {
    description: "Find a matching index with a callback that also receives each index.",
    category: "higher-order",
  },
  some: {
    description: "Test whether any array element matches a callback.",
    category: "higher-order",
  },
  someIndexed: {
    description: "Test for a match with a callback that also receives each index.",
    category: "higher-order",
  },
  every: {
    description: "Test whether every array element matches a callback.",
    category: "higher-order",
  },
  everyIndexed: {
    description: "Test every element with a callback that also receives each index.",
    category: "higher-order",
  },
  count: { description: "Count array elements matching a callback.", category: "higher-order" },
  countIndexed: {
    description: "Count matches with a callback that also receives each index.",
    category: "higher-order",
  },
  sort: {
    description: "Return a sorted copy of an array, optionally using a comparator.",
    category: "higher-order",
  },
  sortBy: {
    description: "Return an array sorted by callback-produced keys.",
    category: "higher-order",
  },
  sortByIndexed: {
    description: "Sort by keys from a callback that also receives each index.",
    category: "higher-order",
  },
  groupBy: {
    description: "Group array elements by callback-produced keys.",
    category: "higher-order",
  },
  groupByIndexed: {
    description: "Group by keys from a callback that also receives each index.",
    category: "higher-order",
  },
  flatMap: {
    description: "Transform array elements and flatten array results by one level.",
    category: "higher-order",
  },
  flatMapIndexed: {
    description: "Flat-map with a callback that also receives each index.",
    category: "higher-order",
  },
  mapValues: {
    description: "Transform an object's values with a callback.",
    category: "higher-order",
  },
  apply: {
    description: "Call a function with an array of positional arguments.",
    category: "higher-order",
  },
  pipe: {
    description: "Pass a value through an array of functions from left to right.",
    category: "higher-order",
  },

  reTest: {
    description: "Test whether a regex pattern matches anywhere in a string.",
    category: "regex",
  },
  reMatch: { description: "Return the first regex match object, or null.", category: "regex" },
  reMatchAll: { description: "Return all non-overlapping regex match objects.", category: "regex" },
  reReplace: {
    description: "Replace all regex matches using a replacement string.",
    category: "regex",
  },
  reSplit: { description: "Split a string using a regex pattern.", category: "regex" },
  reReplaceWith: {
    description: "Replace all regex matches using a callback.",
    category: "higher-order",
  },

  perform: {
    description: "Build a task requesting a named effect with arguments.",
    category: "tasks-effects",
  },
  pure: { description: "Build a completed task carrying a value.", category: "tasks-effects" },
  bind: {
    description: "Sequence a task into a continuation that returns the next task.",
    category: "tasks-effects",
  },
  raise: { description: "Build a task requesting the raise effect.", category: "tasks-effects" },
  handle: {
    description: "Interpret a task's effects with handler clauses.",
    category: "tasks-effects",
  },

  arity: {
    description: "Return a function's positional parameter count, or null when unknown.",
    category: "introspection",
  },
  log: {
    description: "Pass a value to the host-configured logger and return the value unchanged.",
    category: "debugging",
  },
} satisfies Record<string, Metadata>;

const specPath = new URL("./spec/builtins.json", import.meta.url);
const source = await Bun.file(specPath).text();
const parsed = JSON.parse(source) as {
  builtins?: Record<string, { description?: unknown; category?: unknown }>;
};

if (parsed.builtins === undefined || typeof parsed.builtins !== "object") {
  throw new Error("spec/builtins.json does not contain a builtins object");
}

const builtinNames = Object.keys(parsed.builtins);
const metadataNames = Object.keys(metadata);
const missingMetadata = builtinNames.filter((name) => !(name in metadata));
const unknownMetadata = metadataNames.filter((name) => !(name in parsed.builtins!));

if (missingMetadata.length > 0 || unknownMetadata.length > 0) {
  throw new Error(
    [
      missingMetadata.length > 0 ? `Missing metadata: ${missingMetadata.join(", ")}` : "",
      unknownMetadata.length > 0 ? `Unknown metadata: ${unknownMetadata.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

let updated = source;
for (const name of builtinNames) {
  const entry = parsed.builtins[name]!;
  const expected = metadata[name as keyof typeof metadata];

  if (entry.description !== undefined || entry.category !== undefined) {
    if (entry.description !== expected.description || entry.category !== expected.category) {
      throw new Error(`Existing metadata for ${name} does not match the script`);
    }
    continue;
  }

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryStart = new RegExp(`^(    "${escapedName}": \\{)(.*)$`, "m");
  const matches = updated.match(new RegExp(entryStart.source, "gm"));
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one source entry for ${name}, found ${matches?.length ?? 0}`);
  }

  updated = updated.replace(entryStart, (_line: string, prefix: string, suffix: string) => {
    const remaining = suffix.trimStart();
    return [
      prefix,
      `      "description": ${JSON.stringify(expected.description)},`,
      `      "category": ${JSON.stringify(expected.category)},`,
      remaining.length > 0 ? `      ${remaining}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
}

const result = JSON.parse(updated) as {
  builtins: Record<string, { description?: unknown; category?: unknown }>;
};
for (const [name, entry] of Object.entries(result.builtins)) {
  if (typeof entry.description !== "string" || entry.description.length === 0) {
    throw new Error(`${name} does not have a non-empty description`);
  }
  if (typeof entry.category !== "string" || entry.category.length === 0) {
    throw new Error(`${name} does not have a non-empty category`);
  }
}

if (updated !== source) {
  await Bun.write(specPath, updated);
  console.log(`Added descriptions and categories to ${builtinNames.length} builtins.`);
} else {
  console.log(`All ${builtinNames.length} builtins already have descriptions and categories.`);
}
