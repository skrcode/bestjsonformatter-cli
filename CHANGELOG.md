# Changelog

## 0.2.1

- Fix the skills.sh badge destination so it opens the indexed `best-json-formatter` skill.

## 0.2.0

- Publish the full CLI and lossless engine under the MIT license.
- Replace MCP transport with direct file/stdin commands for lower startup and zero model-context
  document transfer.
- Add the `bjf` binary alias.
- Add one-pass `check` diagnostics for syntax, duplicate keys, unsafe numbers, notation risks, and
  optional Draft 2020-12 schemas.
- Add multiple-file formatting and checks, `--check`, atomic `--write`, `--output`, JSON reports,
  stable exit codes, and lazy heavy dependencies.
- Export the core ESM library.
- Add a cross-agent skill, macOS/Linux/Windows CI, correctness fixtures, smoke tests, and a
  reproducible competitor benchmark.

## 0.1.0

- Initial npm release with local CLI and stdio MCP tools.
