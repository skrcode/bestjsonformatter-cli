import {
  canonicalJsonNumber,
  type JsonNode,
  type JsonParseMetadata,
  JsonSyntaxError,
  parseLosslessJson,
} from "./lossless-json.js";

type JsonPathPart = string | number;

export type JsonIssueLocation = {
  line: number;
  column: number;
  offset: number;
};

export type JsonCheckIssue = {
  code:
    | "duplicate-key"
    | "unsafe-number"
    | "number-overflow"
    | "number-underflow"
    | "number-spelling";
  severity: "error" | "warning";
  path: string;
  message: string;
  token?: string;
  locations: JsonIssueLocation[];
};

type JsonCheckSuccess = {
  valid: true;
  clean: boolean;
  issues: JsonCheckIssue[];
  metadata: JsonParseMetadata;
};

type JsonCheckFailure = {
  valid: false;
  clean: false;
  issues: [];
  message: string;
  line: number;
  column: number;
  offset: number;
};

export type JsonCheckResult = JsonCheckSuccess | JsonCheckFailure;

function locationFromOffset(input: string, offset: number): JsonIssueLocation {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (input.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column, offset };
}

function diagnosticPath(path: JsonPathPart[]) {
  return path.reduce<string>((result, part) => {
    if (typeof part === "number") return `${result}[${part}]`;
    return /^[A-Za-z_$][\w$]*$/.test(part)
      ? `${result}.${part}`
      : `${result}[${JSON.stringify(part)}]`;
  }, "$");
}

function numberIssue(input: string, node: Extract<JsonNode, { kind: "number" }>, path: string) {
  const numeric = Number(node.raw);
  const locations = [locationFromOffset(input, node.start)];
  if (!Number.isFinite(numeric)) {
    return {
      code: "number-overflow",
      severity: "error",
      path,
      token: node.raw,
      locations,
      message: `${node.raw} overflows JavaScript Number and becomes Infinity.`,
    } satisfies JsonCheckIssue;
  }
  if (numeric === 0 && canonicalJsonNumber(node.raw) !== "0") {
    return {
      code: "number-underflow",
      severity: "error",
      path,
      token: node.raw,
      locations,
      message: `${node.raw} underflows JavaScript Number and becomes zero.`,
    } satisfies JsonCheckIssue;
  }

  const roundTrip = String(numeric);
  if (canonicalJsonNumber(node.raw) !== canonicalJsonNumber(roundTrip)) {
    return {
      code: "unsafe-number",
      severity: "error",
      path,
      token: node.raw,
      locations,
      message: `${node.raw} rounds to ${roundTrip} as a JavaScript Number.`,
    } satisfies JsonCheckIssue;
  }
  if (roundTrip !== node.raw) {
    return {
      code: "number-spelling",
      severity: "warning",
      path,
      token: node.raw,
      locations,
      message: `${node.raw} keeps its value but ordinary parsers may rewrite it as ${roundTrip}.`,
    } satisfies JsonCheckIssue;
  }
}

export function checkJson(input: string): JsonCheckResult {
  try {
    const parsed = parseLosslessJson(input, { buildTree: true });
    const issues: JsonCheckIssue[] = [];

    const visit = (node: JsonNode, path: JsonPathPart[]) => {
      if (node.kind === "array") {
        node.items.forEach((item, index) => {
          visit(item, [...path, index]);
        });
        return;
      }
      if (node.kind === "object") {
        const entriesByKey = new Map<string, typeof node.entries>();
        for (const entry of node.entries) {
          const entries = entriesByKey.get(entry.key);
          if (entries) entries.push(entry);
          else entriesByKey.set(entry.key, [entry]);
          visit(entry.value, [...path, entry.key]);
        }
        for (const [key, entries] of entriesByKey) {
          if (entries.length < 2) continue;
          issues.push({
            code: "duplicate-key",
            severity: "error",
            path: diagnosticPath([...path, key]),
            locations: entries.map((entry) => locationFromOffset(input, entry.keyStart)),
            message: `${entries.length} properties named ${JSON.stringify(key)} occur in the same object; ordinary parsers usually keep only the last value.`,
          });
        }
        return;
      }
      if (node.kind !== "number") return;
      const issue = numberIssue(input, node, diagnosticPath(path));
      if (issue) issues.push(issue);
    };

    visit(parsed.root, []);
    return {
      valid: true,
      clean: issues.length === 0,
      issues,
      metadata: parsed.metadata,
    };
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return {
        valid: false,
        clean: false,
        issues: [],
        message: error.message,
        line: error.line,
        column: error.column,
        offset: error.offset,
      };
    }
    throw error;
  }
}
