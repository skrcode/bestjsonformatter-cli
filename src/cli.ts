#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ToolOperation } from "./lib/json-tools.js";

type Indent = 0 | 2 | 3 | 4 | "tab";

type CliOptions = {
  indent: Indent;
  sort: boolean;
  write: boolean;
  check: boolean;
  json: boolean;
  quiet: boolean;
  output?: string;
  schema?: string;
};

const help = `Best JSON Formatter — fast, local, lossless JSON tools

Usage:
  bjf format [file ...] [--indent minified|2|3|4|tab] [--sort] [--write|--check]
  bjf check [file ...] [--schema schema.json] [--json]
  bjf validate [file ...] [--json]
  bjf repair [file|-] [--write|-o output.json]
  bjf duplicates [file|-]
  bjf precision [file|-]
  bjf compare <original.json> <changed.json>
  bjf query <jsonpath> [file|-]
  bjf to-yaml|to-csv|to-xml [file|-] [-o output]
  bjf schema-infer [file|-]
  bjf schema-validate <document.json> <schema.json>
  bjf schema-sample [schema.json|-]

Use "-" or pipe stdin for document input. Formatting changes whitespace only:
duplicate keys, large integers, number notation, string escapes, and key order
remain exact unless --sort or repair is explicitly requested.

Options:
  -w, --write       Write the result back atomically
  -c, --check       Exit 1 when formatting differs
  -o, --output      Write to a separate file
      --json        Emit machine-readable check or validation results
  -q, --quiet       Suppress successful human-readable status
  -h, --help        Show help
  -v, --version     Show the installed version`;

function parseIndent(value: string): Indent {
  if (value === "minified" || value === "0") return 0;
  if (value === "tab") return "tab";
  if (value === "2" || value === "3" || value === "4") return Number(value) as 2 | 3 | 4;
  throw new TypeError("--indent must be minified, 2, 3, 4, or tab.");
}

function parseArguments(args: string[]) {
  const options: CliOptions = {
    indent: 2,
    sort: false,
    write: false,
    check: false,
    json: false,
    quiet: false,
  };
  const operands: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-") || argument === "-") {
      operands.push(argument);
      continue;
    }

    const [name, inlineValue] = argument.split("=", 2);
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[index + 1];
      if (next === undefined) throw new TypeError(`${name} requires a value.`);
      index += 1;
      return next;
    };

    switch (name) {
      case "--indent":
        options.indent = parseIndent(value());
        break;
      case "--output":
      case "-o":
        options.output = value();
        break;
      case "--schema":
        options.schema = value();
        break;
      case "--sort":
        options.sort = true;
        break;
      case "--write":
      case "-w":
        options.write = true;
        break;
      case "--check":
      case "-c":
        options.check = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--quiet":
      case "-q":
        options.quiet = true;
        break;
      default:
        throw new TypeError(`Unknown option: ${name}`);
    }
  }

  return { options, operands };
}

async function installedVersion() {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return packageJson.version;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readDocument(path: string) {
  if (path !== "-") return readFile(path, "utf8");
  if (process.stdin.isTTY) throw new TypeError("Provide a file path or pipe JSON through stdin.");
  return readStdin();
}

async function writeStdout(value: string) {
  if (!process.stdout.write(value)) await once(process.stdout, "drain");
}

function withFinalNewline(value: string) {
  return `${value.replace(/\n*$/, "")}\n`;
}

async function writeAtomically(path: string, value: string) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  try {
    await writeFile(temporaryPath, value, mode === undefined ? undefined : { mode });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function displayPath(path: string) {
  return path === "-" ? "<stdin>" : path;
}

function setFailure() {
  process.exitCode = 1;
}

function syntaxFailure(path: string, error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "line" in error &&
    "column" in error &&
    "message" in error
  ) {
    const line = String(error.line);
    const column = String(error.column);
    process.stderr.write(`${displayPath(path)}:${line}:${column} ${String(error.message)}\n`);
  } else {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    process.stderr.write(`${displayPath(path)}: ${message}\n`);
  }
  setFailure();
}

async function formatCommand(files: string[], options: CliOptions) {
  const paths = files.length ? files : ["-"];
  if (options.write && options.check)
    throw new TypeError("--write and --check cannot be combined.");
  if (options.output && (options.write || options.check || paths.length !== 1)) {
    throw new TypeError(
      "--output requires one input and cannot be combined with --write or --check.",
    );
  }
  if (paths.length > 1 && !options.write && !options.check) {
    throw new TypeError("Multiple format inputs require --write or --check.");
  }
  if ((options.write || options.check) && paths.includes("-")) {
    throw new TypeError("--write and --check require file paths, not stdin.");
  }

  const { JsonSyntaxError, formatLosslessJson } = await import("./lib/lossless-json.js");
  for (const path of paths) {
    const input = await readDocument(path);
    try {
      let output: string;
      if (options.sort) {
        const { runTool } = await import("./lib/json-tools.js");
        const result = await runTool({
          operation: "sort",
          input,
          indent: options.indent,
          includeEdits: false,
        });
        if (!result.ok) {
          syntaxFailure(path, result);
          continue;
        }
        output = result.value;
      } else {
        output = formatLosslessJson(input, options.indent).formatted;
      }
      const rendered = withFinalNewline(output);

      if (options.check) {
        if (input !== rendered) {
          process.stderr.write(`${path}: formatting differs\n`);
          setFailure();
        } else if (!options.quiet) {
          process.stdout.write(`${path}: formatted\n`);
        }
      } else if (options.write) {
        if (input !== rendered) await writeAtomically(path, rendered);
        if (!options.quiet)
          process.stdout.write(`${path}: ${input === rendered ? "unchanged" : "formatted"}\n`);
      } else if (options.output) {
        await writeAtomically(options.output, rendered);
      } else {
        await writeStdout(rendered);
      }
    } catch (error) {
      if (error instanceof JsonSyntaxError) syntaxFailure(path, error);
      else throw error;
    }
  }
}

async function validateCommand(files: string[], options: CliOptions) {
  const paths = files.length ? files : ["-"];
  const { JsonSyntaxError, parseLosslessJson } = await import("./lib/lossless-json.js");
  const results: Record<string, unknown>[] = [];

  for (const path of paths) {
    const input = await readDocument(path);
    try {
      const parsed = parseLosslessJson(input);
      results.push({ path: displayPath(path), valid: true, metadata: parsed.metadata });
      if (!options.json && !options.quiet)
        process.stdout.write(`${displayPath(path)}: valid JSON\n`);
    } catch (error) {
      setFailure();
      if (error instanceof JsonSyntaxError) {
        results.push({
          path: displayPath(path),
          valid: false,
          message: error.message,
          line: error.line,
          column: error.column,
          offset: error.offset,
        });
        if (!options.json) syntaxFailure(path, error);
      } else {
        throw error;
      }
    }
  }

  if (options.json) {
    await writeStdout(`${JSON.stringify(paths.length === 1 ? results[0] : results, null, 2)}\n`);
  }
}

async function checkCommand(files: string[], options: CliOptions) {
  const paths = files.length ? files : ["-"];
  const { checkJson } = await import("./lib/json-check.js");
  const schemaInput = options.schema ? await readFile(options.schema, "utf8") : undefined;
  const results: Record<string, unknown>[] = [];

  for (const path of paths) {
    const input = await readDocument(path);
    const result = checkJson(input);
    const schemaErrors: string[] = [];
    if (result.valid && schemaInput !== undefined) {
      const { validateJsonSchema } = await import("./lib/json-schema.js");
      const schemaResult = await validateJsonSchema(input, schemaInput);
      schemaErrors.push(...schemaResult.errors);
    }
    const clean = result.valid && result.clean && schemaErrors.length === 0;
    if (!clean) setFailure();

    results.push({
      path: displayPath(path),
      ...result,
      ...(schemaInput === undefined
        ? {}
        : { schemaValid: schemaErrors.length === 0, schemaErrors }),
    });

    if (options.json) continue;
    if (!result.valid) {
      process.stderr.write(
        `${displayPath(path)}:${result.line}:${result.column} ${result.message}\n`,
      );
      continue;
    }
    for (const issue of result.issues) {
      const location = issue.locations[0];
      process.stderr.write(
        `${displayPath(path)}:${location.line}:${location.column} ${issue.severity} ${issue.code} ${issue.path}: ${issue.message}\n`,
      );
    }
    for (const error of schemaErrors) {
      process.stderr.write(`${displayPath(path)}: error schema: ${error}\n`);
    }
    if (clean && !options.quiet) {
      process.stdout.write(`${displayPath(path)}: valid, lossless-safe JSON\n`);
    }
  }

  if (options.json) {
    await writeStdout(`${JSON.stringify(paths.length === 1 ? results[0] : results, null, 2)}\n`);
  }
}

async function executeToolCommand(command: string, operands: string[], options: CliOptions) {
  const { runTool } = await import("./lib/json-tools.js");
  let operation: ToolOperation;
  let inputPath = operands[0] ?? "-";
  let secondaryInput: string | undefined;
  let query: string | undefined;

  switch (command) {
    case "repair":
      operation = "repair";
      break;
    case "duplicates":
      operation = "duplicates";
      break;
    case "precision":
      operation = "precision";
      break;
    case "compare":
      if (operands.length !== 2) throw new TypeError("compare requires two JSON files.");
      operation = "compare";
      inputPath = operands[0];
      secondaryInput = await readDocument(operands[1]);
      break;
    case "query":
      if (!operands[0]) throw new TypeError("query requires a JSONPath expression.");
      operation = "jsonpath";
      query = operands[0];
      inputPath = operands[1] ?? "-";
      break;
    case "to-yaml":
    case "to-csv":
    case "to-xml":
      operation = command.slice(3) as "yaml" | "csv" | "xml";
      break;
    case "schema-infer":
      operation = "schema";
      break;
    case "schema-validate":
      if (operands.length !== 2) {
        throw new TypeError("schema-validate requires a JSON file and a schema file.");
      }
      operation = "schema_validate";
      inputPath = operands[0];
      secondaryInput = await readDocument(operands[1]);
      break;
    case "schema-sample":
      operation = "schema_sample";
      break;
    default:
      throw new TypeError(`Unknown command: ${command}`);
  }

  if (options.write && command !== "repair") {
    throw new TypeError("--write is supported by format and repair.");
  }
  if (options.output && options.write)
    throw new TypeError("--output and --write cannot be combined.");
  if (options.write && inputPath === "-") throw new TypeError("--write requires a file path.");

  const input = await readDocument(inputPath);
  const result = await runTool({
    operation,
    input,
    secondaryInput,
    query,
    indent: options.indent,
    includeEdits: false,
  });
  if (!result.ok) {
    syntaxFailure(inputPath, result);
    return;
  }

  const rendered = withFinalNewline(result.value);
  if (options.write) {
    await writeAtomically(inputPath, rendered);
    if (!options.quiet) process.stdout.write(`${inputPath}: repaired\n`);
  } else if (options.output) {
    await writeAtomically(options.output, rendered);
  } else {
    await writeStdout(rendered);
  }
}

async function main(args: string[]) {
  const first = args[0];
  if (!first || first === "help" || first === "--help" || first === "-h") {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    process.stdout.write(`${await installedVersion()}\n`);
    return;
  }

  const { options, operands } = parseArguments(args.slice(1));
  if (first === "format") await formatCommand(operands, options);
  else if (first === "validate") await validateCommand(operands, options);
  else if (first === "check") await checkCommand(operands, options);
  else await executeToolCommand(first, operands, options);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : "The command failed.";
  process.stderr.write(`bestjsonformatter: ${message}\n`);
  process.exitCode = 2;
});
