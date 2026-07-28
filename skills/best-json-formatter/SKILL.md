---
name: best-json-formatter
description: Check, format, repair, compare, query, convert, and validate JSON locally without losing duplicate keys, large integers, number notation, or escape spelling. Use when an agent needs to inspect or change JSON files, diagnose malformed JSON, enforce JSON correctness in CI, work with JSON Schema, or avoid lossy JSON.parse/stringify round trips.
---

# Best JSON Formatter

Use the `bestjsonformatter` npm CLI through its short `bjf` binary when installed locally. Otherwise
run the pinned package through `npx`.

## Check JSON

Run the combined correctness check before editing or committing JSON:

```bash
npx -y bestjsonformatter@latest check path/to/file.json --json
```

Treat exit code `0` as clean, `1` as invalid or correctness findings, and `2` as a command failure.
Report exact paths, issue codes, and source locations. Never dismiss duplicate keys or unsafe-number
findings merely because `JSON.parse` accepts the document.

Validate against a schema when one is in scope:

```bash
npx -y bestjsonformatter@latest check document.json --schema schema.json --json
```

## Format safely

Preview formatted output through stdout:

```bash
npx -y bestjsonformatter@latest format path/to/file.json
```

Check formatting without changing the file:

```bash
npx -y bestjsonformatter@latest format path/to/file.json --check
```

Use `--write` only when the user has authorized file changes:

```bash
npx -y bestjsonformatter@latest format path/to/file.json --write
```

Ordinary formatting changes whitespace only. Use `--sort` only when key reordering is explicitly
wanted. Review `repair` output before replacing a source document.

## Other operations

```bash
bjf repair broken.json
bjf compare before.json after.json
bjf query '$.items[*].id' response.json
bjf to-yaml response.json
bjf schema-infer response.json
bjf schema-validate response.json schema.json
```

Pass file paths or stdin, not document contents in shell arguments. All processing stays in the
local Node.js process and the CLI sends no analytics or document data over the network.
