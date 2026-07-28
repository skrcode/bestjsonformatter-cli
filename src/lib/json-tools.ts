import type { ScalarTag } from "yaml";
import {
  canonicalJsonNumber,
  formatLosslessJson,
  type JsonNode,
  JsonSyntaxError,
  jsonNodeToNative,
  LosslessNumber,
  type LosslessTreeResult,
  parseLosslessJson,
  serializeJsonNode,
  stringifyNativeLosslessly,
} from "./lossless-json.js";

export type ToolOperation =
  | "format"
  | "minify"
  | "validate"
  | "repair"
  | "sort"
  | "yaml"
  | "csv"
  | "xml"
  | "jsonpath"
  | "compare"
  | "duplicates"
  | "precision"
  | "schema"
  | "schema_validate"
  | "schema_sample";

export type TextEdit = {
  from: number;
  to: number;
  insert: string;
};

type ToolSuccess = {
  ok: true;
  value: string;
  edits?: TextEdit[];
  metadata?: Record<string, string | number | boolean>;
};

export type ToolFailure = {
  ok: false;
  message: string;
  line?: number;
  column?: number;
  offset?: number;
  suggestion?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type ToolResult = ToolSuccess | ToolFailure;

const textEncoder = new TextEncoder();
export type ToolRequest = {
  id: number;
  operation: ToolOperation;
  input: string;
  secondaryInput?: string;
  indent?: 0 | 2 | 3 | 4 | "tab";
  query?: string;
  includeEdits?: boolean;
};

export type ToolResponse = { id: number; result: ToolResult };

function locationFromOffset(input: string, offset: number) {
  const before = input.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

type JsonPathPart = string | number;

function diagnosticPath(path: JsonPathPart[]) {
  return path.reduce<string>((result, part) => {
    if (typeof part === "number") return `${result}[${part}]`;
    return /^[A-Za-z_$][\w$]*$/.test(part)
      ? `${result}.${part}`
      : `${result}[${JSON.stringify(part)}]`;
  }, "$");
}

function duplicateKeyReport(input: string, root: JsonNode) {
  const findings: {
    path: string;
    locations: { line: number; column: number }[];
  }[] = [];

  const visit = (node: JsonNode, path: JsonPathPart[]) => {
    if (node.kind === "array") {
      node.items.forEach((item, index) => {
        visit(item, [...path, index]);
      });
      return;
    }
    if (node.kind !== "object") return;

    const entriesByKey = new Map<string, typeof node.entries>();
    for (const entry of node.entries) {
      const entries = entriesByKey.get(entry.key);
      if (entries) entries.push(entry);
      else entriesByKey.set(entry.key, [entry]);
      visit(entry.value, [...path, entry.key]);
    }
    for (const [key, entries] of entriesByKey) {
      if (entries.length < 2) continue;
      findings.push({
        path: diagnosticPath([...path, key]),
        locations: entries.map((entry) => locationFromOffset(input, entry.keyStart)),
      });
    }
  };

  visit(root, []);
  if (!findings.length) {
    return {
      value: "No duplicate property names found. Every object key is unique.",
      findings: 0,
    };
  }

  return {
    value: [
      `${findings.length} duplicate ${findings.length === 1 ? "property group" : "property groups"} found.`,
      "Most object parsers keep only the last occurrence, so earlier values can disappear without warning.",
      "",
      ...findings.flatMap((finding, index) => [
        `${index + 1}. ${finding.path}`,
        `   ${finding.locations.length} occurrences · ${finding.locations
          .map(({ line, column }) => `line ${line}, column ${column}`)
          .join(" · ")}`,
      ]),
    ].join("\n"),
    findings: findings.length,
  };
}

function numberPrecisionReport(input: string, root: JsonNode) {
  const findings: {
    path: string;
    raw: string;
    line: number;
    column: number;
    issue: string;
  }[] = [];

  const visit = (node: JsonNode, path: JsonPathPart[]) => {
    if (node.kind === "array") {
      node.items.forEach((item, index) => {
        visit(item, [...path, index]);
      });
      return;
    }
    if (node.kind === "object") {
      node.entries.forEach((entry) => {
        visit(entry.value, [...path, entry.key]);
      });
      return;
    }
    if (node.kind !== "number") return;

    const numeric = Number(node.raw);
    let issue = "";
    if (!Number.isFinite(numeric)) {
      issue = "overflows JavaScript Number and becomes Infinity";
    } else if (numeric === 0 && canonicalJsonNumber(node.raw) !== "0") {
      issue = "underflows JavaScript Number and becomes zero";
    } else {
      const roundTrip = String(numeric);
      if (canonicalJsonNumber(node.raw) !== canonicalJsonNumber(roundTrip)) {
        issue = `rounds to ${roundTrip} as a JavaScript Number`;
      } else if (roundTrip !== node.raw) {
        issue = `keeps its value but normalizes its spelling to ${roundTrip}`;
      }
    }
    if (!issue) return;
    findings.push({
      path: diagnosticPath(path),
      raw: node.raw,
      ...locationFromOffset(input, node.start),
      issue,
    });
  };

  visit(root, []);
  if (!findings.length) {
    return {
      value: "No JavaScript number precision or notation risks found.",
      findings: 0,
    };
  }

  return {
    value: [
      `${findings.length} numeric ${findings.length === 1 ? "risk" : "risks"} found.`,
      "Best JSON Formatter preserves every original number token. The notes below describe what ordinary JavaScript Number conversion would do.",
      "",
      ...findings.flatMap((finding, index) => [
        `${index + 1}. ${finding.path} · line ${finding.line}, column ${finding.column}`,
        `   ${finding.raw} — ${finding.issue}.`,
      ]),
    ].join("\n"),
    findings: findings.length,
  };
}

function parseError(input: string, error: unknown): ToolFailure {
  if (error instanceof JsonSyntaxError) {
    return {
      ok: false,
      message: error.message,
      line: error.line,
      column: error.column,
      offset: error.offset,
      suggestion: "Use Repair to preview a safe correction.",
    };
  }
  const message = error instanceof Error ? error.message : "Invalid JSON";
  const cleanMessage = message
    .replace(/^JSON\.parse:\s*/i, "")
    .replace(/\s+at position\s+\d+(?:\s+\(line\s+\d+\s+column\s+\d+\))?$/i, "")
    .replace(/\s+at line\s+\d+\s+column\s+\d+.*$/i, "");
  const positionMatch = message.match(/position\s+(\d+)/i);
  const lineColumnMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  const offset = positionMatch ? Number(positionMatch[1]) : undefined;
  const location =
    offset !== undefined
      ? locationFromOffset(input, offset)
      : lineColumnMatch
        ? { line: Number(lineColumnMatch[1]), column: Number(lineColumnMatch[2]) }
        : {};

  return {
    ok: false,
    message: cleanMessage,
    offset,
    ...location,
    suggestion: "Use Repair to preview a safe correction.",
  };
}

export function parseJson(input: string): { ok: true; data: unknown } | ToolFailure {
  try {
    const parsed = parseLosslessJson(input, { buildTree: true });
    return { ok: true, data: jsonNodeToNative(parsed.root, false) };
  } catch (error) {
    return parseError(input, error);
  }
}

function countDiffLines(value: string) {
  if (!value) return 0;
  return value.endsWith("\n") ? value.slice(0, -1).split("\n").length : value.split("\n").length;
}

function prefixDiffLines(value: string, prefix: string) {
  const withoutTrailingNewline = value.endsWith("\n") ? value.slice(0, -1) : value;
  return withoutTrailingNewline.split("\n").map((line) => `${prefix}${line}`);
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlTag(key: string) {
  return /^[A-Za-z_][\w.-]*$/.test(key) ? key : "item";
}

function toXml(value: JsonNode, key = "root", depth = 0): string {
  const tag = xmlTag(key);
  const keyAttribute = tag === key ? "" : ` key="${escapeXml(key)}"`;
  const padding = "  ".repeat(depth);

  if (value.kind === "null") return `${padding}<${tag}${keyAttribute} null="true" />`;
  if (value.kind === "array") {
    if (!value.items.length) return `${padding}<${tag}${keyAttribute} />`;
    const children = value.items.map((child) => toXml(child, "item", depth + 1)).join("\n");
    return `${padding}<${tag}${keyAttribute}>\n${children}\n${padding}</${tag}>`;
  }
  if (value.kind === "object") {
    if (!value.entries.length) return `${padding}<${tag}${keyAttribute} />`;
    const children = value.entries
      .map((entry) => toXml(entry.value, entry.key, depth + 1))
      .join("\n");
    return `${padding}<${tag}${keyAttribute}>\n${children}\n${padding}</${tag}>`;
  }

  const primitive = value.kind === "string" ? value.value : value.raw;
  return `${padding}<${tag}${keyAttribute}>${escapeXml(primitive)}</${tag}>`;
}

function csvCell(value: JsonNode | undefined) {
  if (!value || value.kind === "null") return "";
  const raw =
    value.kind === "string"
      ? value.value
      : value.kind === "number" || value.kind === "boolean"
        ? value.raw
        : serializeJsonNode(value, 0);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function toCsv(root: JsonNode) {
  if (root.kind !== "array" || root.items.some((item) => item.kind !== "object")) {
    throw new TypeError("CSV conversion requires an array of objects.");
  }
  const rows = root.items as Extract<JsonNode, { kind: "object" }>[];
  const headers: string[] = [];
  const knownHeaders = new Set<string>();
  for (const row of rows) {
    for (const entry of row.entries) {
      if (!knownHeaders.has(entry.key)) {
        knownHeaders.add(entry.key);
        headers.push(entry.key);
      }
    }
  }
  const lines = [
    headers
      .map((header) =>
        csvCell({
          kind: "string",
          value: header,
          raw: JSON.stringify(header),
          start: 0,
          end: 0,
        }),
      )
      .join(","),
  ];
  for (const row of rows) {
    const values = new Map(row.entries.map((entry) => [entry.key, entry.value]));
    lines.push(headers.map((header) => csvCell(values.get(header))).join(","));
  }
  return lines.join("\r\n");
}

function formattingEdits(input: string, output: string): TextEdit[] | undefined {
  const edits: TextEdit[] = [];
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < input.length || outputOffset < output.length) {
    const inputCharacter = input[inputOffset];
    const outputCharacter = output[outputOffset];
    if (inputCharacter === '"') {
      const inputStart = inputOffset;
      inputOffset += 1;
      while (inputOffset < input.length) {
        if (input[inputOffset] === "\\") inputOffset += 2;
        else if (input[inputOffset++] === '"') break;
      }
      const tokenLength = inputOffset - inputStart;
      if (
        output.slice(outputOffset, outputOffset + tokenLength) !==
        input.slice(inputStart, inputOffset)
      ) {
        return undefined;
      }
      outputOffset += tokenLength;
      continue;
    }

    const inputWhitespaceStart = inputOffset;
    const outputWhitespaceStart = outputOffset;
    while (inputOffset < input.length && /[\t\n\r ]/.test(input[inputOffset])) inputOffset += 1;
    while (outputOffset < output.length && /[\t\n\r ]/.test(output[outputOffset]))
      outputOffset += 1;
    if (inputOffset !== inputWhitespaceStart || outputOffset !== outputWhitespaceStart) {
      const before = input.slice(inputWhitespaceStart, inputOffset);
      const after = output.slice(outputWhitespaceStart, outputOffset);
      if (before !== after) {
        edits.push({ from: inputWhitespaceStart, to: inputOffset, insert: after });
        if (edits.length > 20_000) return undefined;
      }
      continue;
    }

    if (inputCharacter !== outputCharacter) return undefined;
    inputOffset += 1;
    outputOffset += 1;
  }
  return edits;
}

async function executeTool(request: Omit<ToolRequest, "id">): Promise<ToolResult> {
  if (request.operation === "repair") {
    try {
      const { jsonrepair } = await import("jsonrepair");
      const value = jsonrepair(request.input);
      const parsed = parseLosslessJson(value);
      return {
        ok: true,
        value,
        metadata: {
          changed: value !== request.input,
          duplicateKeys: parsed.metadata.duplicateKeys,
          unsafeNumbers: parsed.metadata.unsafeNumbers,
        },
      };
    } catch (error) {
      return parseError(request.input, error);
    }
  }

  if (request.operation === "compare") {
    let left: LosslessTreeResult;
    let right: LosslessTreeResult;
    try {
      left = parseLosslessJson(request.input, { buildTree: true });
    } catch (error) {
      return parseError(request.input, error);
    }
    try {
      right = parseLosslessJson(request.secondaryInput ?? "", { buildTree: true });
    } catch (error) {
      const failure = parseError(request.secondaryInput ?? "", error);
      return { ...failure, message: `Second document: ${failure.message}` };
    }

    const { diffLines } = await import("diff");
    const leftValue = serializeJsonNode(left.root, 2, true);
    const rightValue = serializeJsonNode(right.root, 2, true);
    const semanticallyIdentical =
      serializeJsonNode(left.root, 0, true, true) === serializeJsonNode(right.root, 0, true, true);
    const parts = diffLines(leftValue, rightValue);
    const changedAdditions = parts
      .filter((part) => part.added)
      .reduce((total, part) => total + countDiffLines(part.value), 0);
    const changedRemovals = parts
      .filter((part) => part.removed)
      .reduce((total, part) => total + countDiffLines(part.value), 0);
    const identical = semanticallyIdentical;
    const additions = identical ? 0 : changedAdditions;
    const removals = identical ? 0 : changedRemovals;
    const value = identical
      ? "No structural differences. The JSON documents are equivalent."
      : [
          "--- Original",
          "+++ Changed",
          ...parts.flatMap((part) =>
            prefixDiffLines(part.value, part.added ? "+ " : part.removed ? "- " : "  "),
          ),
        ].join("\n");
    return {
      ok: true,
      value,
      metadata: {
        additions,
        removals,
        identical,
        duplicateKeys: left.metadata.duplicateKeys + right.metadata.duplicateKeys,
        unsafeNumbers: left.metadata.unsafeNumbers + right.metadata.unsafeNumbers,
      },
    };
  }

  if (
    request.operation === "schema" ||
    request.operation === "schema_validate" ||
    request.operation === "schema_sample"
  ) {
    try {
      const schemaTools = await import("./json-schema.js");
      if (request.operation === "schema") {
        const inferred = schemaTools.inferJsonSchema(request.input);
        return {
          ok: true,
          value: JSON.stringify(inferred.schema, null, 2),
          metadata: {
            duplicateKeys: inferred.metadata.duplicateKeys,
            unsafeNumbers: inferred.metadata.unsafeNumbers,
          },
        };
      }
      if (request.operation === "schema_sample") {
        const sample = schemaTools.generateJsonSample(request.input);
        return {
          ok: true,
          value: sample.value,
          metadata: {
            duplicateKeys: sample.metadata.duplicateKeys,
            unsafeNumbers: sample.metadata.unsafeNumbers,
          },
        };
      }
      const validated = await schemaTools.validateJsonSchema(
        request.input,
        request.secondaryInput ?? "",
      );
      return {
        ok: true,
        value: validated.valid
          ? "Valid against this JSON Schema."
          : validated.errors.map((error, index) => `${index + 1}. ${error}`).join("\n"),
        metadata: {
          ...validated.metadata,
          schemaValid: validated.valid,
          results: validated.errors.length,
        },
      };
    } catch (error) {
      return parseError(
        request.operation === "schema_validate" && !request.secondaryInput?.trim()
          ? (request.secondaryInput ?? "")
          : request.input,
        error,
      );
    }
  }

  try {
    if (request.operation === "duplicates" || request.operation === "precision") {
      const parsed = parseLosslessJson(request.input, { buildTree: true });
      const report =
        request.operation === "duplicates"
          ? duplicateKeyReport(request.input, parsed.root)
          : numberPrecisionReport(request.input, parsed.root);
      return {
        ok: true,
        value: report.value,
        metadata: {
          type: parsed.metadata.type,
          duplicateKeys: parsed.metadata.duplicateKeys,
          unsafeNumbers: parsed.metadata.unsafeNumbers,
          values: parsed.metadata.values,
          results: report.findings,
        },
      };
    }
    if (
      request.operation === "format" ||
      request.operation === "minify" ||
      request.operation === "validate"
    ) {
      if (request.operation === "validate") {
        const parsed = parseLosslessJson(request.input);
        return {
          ok: true,
          value: request.input,
          metadata: {
            type: parsed.metadata.type,
            duplicateKeys: parsed.metadata.duplicateKeys,
            unsafeNumbers: parsed.metadata.unsafeNumbers,
            values: parsed.metadata.values,
            bytes: textEncoder.encode(request.input).length,
          },
        };
      }
      const parsed = formatLosslessJson(
        request.input,
        request.operation === "minify" ? 0 : request.indent,
      );
      return {
        ok: true,
        value: parsed.formatted,
        edits:
          request.includeEdits === false
            ? undefined
            : formattingEdits(request.input, parsed.formatted),
        metadata: {
          type: parsed.metadata.type,
          duplicateKeys: parsed.metadata.duplicateKeys,
          unsafeNumbers: parsed.metadata.unsafeNumbers,
          values: parsed.metadata.values,
        },
      };
    }

    const parsed = parseLosslessJson(request.input, { buildTree: true });
    const root = parsed.root;
    const parseMetadata = {
      duplicateKeys: parsed.metadata.duplicateKeys,
      unsafeNumbers: parsed.metadata.unsafeNumbers,
    };
    switch (request.operation) {
      case "sort":
        return {
          ok: true,
          value: serializeJsonNode(root, request.indent, true),
          metadata: parseMetadata,
        };
      case "yaml": {
        const losslessNumberTag: ScalarTag = {
          identify: (value) => value instanceof LosslessNumber,
          default: true,
          tag: "tag:yaml.org,2002:float",
          test: /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/,
          resolve: (raw) => new LosslessNumber(raw),
          stringify: (node) => (node.value as LosslessNumber).raw,
        };
        return {
          ok: true,
          value: (await import("yaml")).stringify(jsonNodeToNative(root, true), {
            customTags: [losslessNumberTag],
          }),
          metadata: parseMetadata,
        };
      }
      case "csv":
        return { ok: true, value: toCsv(root), metadata: parseMetadata };
      case "xml":
        return {
          ok: true,
          value: `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(root)}`,
          metadata: parseMetadata,
        };
      case "jsonpath": {
        const query = request.query?.trim();
        if (!query)
          return { ok: false, message: "Enter a JSONPath query, such as $.store.book[*].title." };
        const { JSONPath } = await import("jsonpath-plus");
        const result = JSONPath({ path: query, json: jsonNodeToNative(root, true) as object });
        return {
          ok: true,
          value: stringifyNativeLosslessly(result, request.indent),
          metadata: {
            ...parseMetadata,
            results: Array.isArray(result) ? result.length : 1,
          },
        };
      }
    }
  } catch (error) {
    if (error instanceof JsonSyntaxError) return parseError(request.input, error);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The operation could not be completed.",
    };
  }
}

export async function runTool(request: Omit<ToolRequest, "id">): Promise<ToolResult> {
  const result = await executeTool(request);
  return {
    ...result,
    metadata: {
      inputBytes: textEncoder.encode(request.input).byteLength,
      ...(result.ok ? { outputBytes: textEncoder.encode(result.value).byteLength } : {}),
      ...result.metadata,
    },
  };
}
