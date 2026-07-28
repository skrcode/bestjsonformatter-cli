# Best JSON Formatter CLI

[![npm](https://img.shields.io/npm/v/bestjsonformatter)](https://www.npmjs.com/package/bestjsonformatter)
[![CI](https://github.com/skrcode/bestjsonformatter-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/skrcode/bestjsonformatter-cli/actions/workflows/ci.yml)
[![skills.sh](https://skills.sh/b/skrcode/bestjsonformatter-cli)](https://skills.sh/skrcode/bestjsonformatter-cli)

Fast, local JSON formatting and correctness checks without lossy
`JSON.parse()`/`JSON.stringify()` round trips.

```bash
npx -y bestjsonformatter@latest check response.json
npx -y bestjsonformatter@latest format response.json --write
```

Best JSON Formatter preserves duplicate object properties, integers beyond JavaScript's safe
range, decimal and exponent spelling, string escape spelling, and property order. It performs no
network requests, collects no analytics, and requires no MCP server or account.

## Install

Use it without installing:

```bash
npx -y bestjsonformatter@latest check package.json
```

Or install the short `bjf` command:

```bash
npm install --global bestjsonformatter
bjf check package.json
```

Node.js 20 or newer is required.

## Check JSON

`check` validates syntax and finds duplicate keys and numbers that ordinary JavaScript parsing may
round, overflow, underflow, or rewrite:

```bash
bjf check response.json
bjf check response.json --json
bjf check response.json --schema response.schema.json
```

Exit codes are stable for CI and coding agents:

| Code | Meaning |
| ---: | --- |
| `0` | Valid JSON with no selected correctness findings |
| `1` | Invalid JSON, correctness findings, schema errors, or formatting differences |
| `2` | Invalid command, inaccessible file, or internal failure |

## Format JSON

```bash
bjf format response.json
bjf format response.json --check
bjf format response.json --write
bjf format response.json --indent minified
bjf format response.json --indent tab
bjf format response.json --sort
```

Ordinary formatting changes whitespace only. `--sort` explicitly reorders object properties while
preserving array order and exact scalar tokens. `--write` uses a same-directory temporary file and
atomic rename.

Multiple files are supported when checking or writing:

```bash
bjf format package.json fixtures/*.json --check
bjf format package.json fixtures/*.json --write
bjf check fixtures/*.json --json
```

## Repair, query, compare, convert, and use schemas

```bash
bjf repair broken.json
bjf repair broken.json --write
bjf duplicates response.json
bjf precision response.json
bjf compare before.json after.json
bjf query '$.items[*].id' response.json
bjf to-yaml response.json
bjf to-csv records.json
bjf to-xml response.json
bjf schema-infer response.json
bjf schema-validate response.json schema.json
bjf schema-sample schema.json
```

Repair output is a proposal unless `--write` is explicitly supplied. Use `-o output.ext` to write
conversion or repair output to a separate file.

## Coding agents

Agents can call the CLI directly through their normal shell, so JSON never has to be copied into an
MCP tool argument or model context.

Install the agent skill:

```bash
npx skills add skrcode/bestjsonformatter-cli
```

The skill teaches Codex, Claude Code, Cursor, GitHub Copilot, and other compatible agents to run
compact checks first and request explicit authorization before `--write`.

## Library

The same engine is available as an ESM library:

```ts
import { checkJson, formatLosslessJson } from "bestjsonformatter";

const checked = checkJson(source);
const formatted = formatLosslessJson(source, 2).formatted;
```

Heavy repair, diff, query, conversion, and schema dependencies are loaded only when their
operations are requested. Formatting, validation, and correctness checks stay on the small local
hot path.

## Performance and correctness

In the repository's reproducible five-run benchmark, Best JSON Formatter is the fastest formatter
that passes every exact-token check.

| Fresh-process median | 155 B | 105 KB | 1.07 MB | 5.35 MB | Fully lossless |
| --- | ---: | ---: | ---: | ---: | :---: |
| Best JSON Formatter 0.2.0 | **54 ms** | **76 ms** | **143 ms** | **473 ms** | Yes |
| Biome 2.5.6 | 58 ms | 88 ms | 280 ms | 1,150 ms | No |
| Prettier 3.9.6 | 120 ms | 234 ms | 955 ms | 3,926 ms | No |
| jsonc-parser 3.3.1 | 63 ms | 825 ms | >15,000 ms | >15,000 ms | Yes |
| jq 1.8.2 | 5 ms | 14 ms | 105 ms | 500 ms | No |

The comparison uses identical stdin payloads and complete fresh CLI processes. jq is faster on
small and one-megabyte inputs but discards duplicate keys and rewrites number and escape spelling.
Results are bounded to the recorded machine, versions, inputs, and command boundaries—not a
universal speed claim. See [the complete method, raw samples, Python and native Node
results](docs/BENCHMARKS.md).

## Privacy

Documents are read and processed inside the local Node.js process. The package contains no
telemetry client, post-install script, network request, account system, or hosted document API.

## Development

```bash
npm install
npm run check
npm run benchmark
```

Every formatting change must preserve the exact-token fixtures. Performance changes must record
the complete journey, competitor versions, raw samples, median, p95, correctness, and timeouts.

MIT licensed. The browser tool is available at
[bestjsonformatter.org](https://bestjsonformatter.org).
