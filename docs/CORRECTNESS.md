# Lossless correctness contract

Ordinary `format` and minified formatting preserve every non-whitespace JSON token:

- duplicate object properties and their order;
- integers larger than JavaScript's safe range;
- decimal and exponent spelling, including trailing zeroes and exponent case;
- original string and property-name escape spelling;
- array order, object-property order, booleans, and null.

Whitespace before, between, and after tokens may change. File output uses one final newline.

Operations that intentionally have a broader effect are explicit:

- `format --sort` reorders object properties recursively while preserving arrays and scalar tokens;
- `repair` proposes or writes syntax changes;
- YAML, CSV, and XML conversion changes the document format;
- schema inference and sample generation produce new documents;
- comparison canonicalizes number values only for deciding semantic equality and never rewrites an
  input file.

`check` parses once and reports:

- invalid syntax with deterministic line, column, and byte-independent string offset;
- duplicate property groups with every source location;
- JavaScript number rounding, overflow, and underflow;
- valid numeric tokens whose spelling ordinary number conversion may normalize;
- optional Draft 2020-12 JSON Schema errors.

The parser rejects nesting deeper than 4,096 levels. Documents are currently buffered as UTF-8
text; benchmark both time and peak memory before changing the large-document strategy.
