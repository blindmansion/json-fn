# Testing shorthand parsing

The files under `spec/cases/parse/` test portable shorthand parsing and
lowering. Validate each file against `spec/cases/parse.schema.json` before
registering any of its cases.

Run every `.json` file in that directory. A suite's `mode` selects the
expression or module parser and defaults to `expression`; a case-level `mode`
overrides it. Pass `source` to that parser exactly as stored, without trimming,
normalizing newlines, or otherwise preprocessing it. The optional `comment`
fields are maintenance notes and do not affect execution.

## Successful parses

For `expected`, compare the parser's canonical JSON result using exact
structural JSON equality. An explicit `null` is an expected result, not a
missing outcome. JSON object member order is not part of this comparison.

The expected value is the parser's direct result. Do not print and reparse it,
or normalize it through another representation before comparing.

## Parse errors

An `error` value always requires parsing to fail:

- `true` accepts any parse failure.
- A string must occur in the error message.
- A structured error independently checks `messageIncludes`, `at`, or both.

Do not require a particular implementation exception class. Read the message
from the implementation's ordinary error value and read source coordinates
from its portable diagnostic data.

Positions are one-based `{ line, column }` coordinates in the original
`source`. Columns count Unicode code points, not UTF-16 code units or encoded
bytes. The first code point on each line is column 1.

## Fixed limits

Structural-depth cases exercise the fixed language limit, not a configurable
runner budget. Run their concrete source and expected JSON like any other
case; do not replace them with implementation-specific fixture shorthand or a
different depth setting.
