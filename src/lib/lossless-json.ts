export type JsonObjectEntry = {
  key: string;
  keyRaw: string;
  keyStart: number;
  keyEnd: number;
  duplicate: boolean;
  value: JsonNode;
};

type JsonNodeBase = {
  start: number;
  end: number;
};

export type JsonNode =
  | (JsonNodeBase & { kind: "object"; entries: JsonObjectEntry[] })
  | (JsonNodeBase & { kind: "array"; items: JsonNode[] })
  | (JsonNodeBase & { kind: "string"; value: string; raw: string })
  | (JsonNodeBase & { kind: "number"; raw: string })
  | (JsonNodeBase & { kind: "boolean"; value: boolean; raw: "true" | "false" })
  | (JsonNodeBase & { kind: "null"; raw: "null" });

export type JsonParseMetadata = {
  type: JsonNode["kind"];
  duplicateKeys: number;
  unsafeNumbers: number;
  values: number;
  treeTruncated: boolean;
};

export type LosslessParseResult = {
  root?: JsonNode;
  formatted?: string;
  metadata: JsonParseMetadata;
};

export type LosslessTreeResult = LosslessParseResult & { root: JsonNode };
export type LosslessFormatResult = LosslessParseResult & { formatted: string };

export class JsonSyntaxError extends Error {
  offset: number;
  line: number;
  column: number;

  constructor(message: string, input: string, offset: number) {
    super(message);
    this.name = "JsonSyntaxError";
    this.offset = Math.max(0, Math.min(offset, input.length));
    const before = input.slice(0, this.offset);
    this.line = 1;
    this.column = 1;
    for (let index = 0; index < before.length; index += 1) {
      if (before.charCodeAt(index) === 10) {
        this.line += 1;
        this.column = 1;
      } else {
        this.column += 1;
      }
    }
  }
}

type ParserOptions = {
  buildTree?: boolean;
  indent?: "" | "  " | "   " | "    " | "\t";
  maxTreeValues?: number;
};

const MAX_DEPTH = 4_096;

class LosslessParser {
  private readonly input: string;
  private buildTree: boolean;
  private readonly maxTreeValues: number;
  private readonly indent: ParserOptions["indent"];
  private readonly output: string[] | null;
  private position = 0;
  private depth = 0;
  private duplicateKeys = 0;
  private unsafeNumbers = 0;
  private values = 0;
  private treeTruncated = false;
  private rootType: JsonNode["kind"] = "null";

  constructor(input: string, options: ParserOptions) {
    this.input = input;
    this.buildTree = options.buildTree === true;
    this.maxTreeValues = options.maxTreeValues ?? Number.POSITIVE_INFINITY;
    this.indent = options.indent;
    this.output = options.indent === undefined ? null : [];
  }

  parse(): LosslessParseResult {
    this.skipWhitespace();
    if (this.position === this.input.length) this.fail("Paste or upload JSON to begin.");
    const first = this.input[this.position];
    this.rootType =
      first === "{"
        ? "object"
        : first === "["
          ? "array"
          : first === '"'
            ? "string"
            : first === "t" || first === "f"
              ? "boolean"
              : first === "n"
                ? "null"
                : "number";
    const root = this.parseValue();
    this.skipWhitespace();
    if (this.position !== this.input.length) this.fail("Unexpected content after the JSON value.");
    if (root) this.rootType = root.kind;

    return {
      root,
      formatted: this.output?.join(""),
      metadata: {
        type: this.rootType,
        duplicateKeys: this.duplicateKeys,
        unsafeNumbers: this.unsafeNumbers,
        values: this.values,
        treeTruncated: this.treeTruncated,
      },
    };
  }

  private fail(message: string, offset = this.position): never {
    throw new JsonSyntaxError(message, this.input, offset);
  }

  private write(value: string) {
    this.output?.push(value);
  }

  private writeLine(depth = this.depth) {
    if (this.indent) this.write(`\n${this.indent.repeat(depth)}`);
  }

  private skipWhitespace() {
    while (this.position < this.input.length) {
      const code = this.input.charCodeAt(this.position);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      this.position += 1;
    }
  }

  private parseValue(): JsonNode | undefined {
    if (this.depth > MAX_DEPTH)
      this.fail(`JSON nesting exceeds the supported depth of ${MAX_DEPTH}.`);
    this.values += 1;
    if (this.buildTree && this.values > this.maxTreeValues) {
      this.buildTree = false;
      this.treeTruncated = true;
    }
    const character = this.input[this.position];
    let node: JsonNode | undefined;

    if (character === "{") node = this.parseObject();
    else if (character === "[") node = this.parseArray();
    else if (character === '"') node = this.parseString();
    else if (character === "t") node = this.parseLiteral("true", true);
    else if (character === "f") node = this.parseLiteral("false", false);
    else if (character === "n") node = this.parseNull();
    else if (character === "-" || (character >= "0" && character <= "9")) node = this.parseNumber();
    else if (character === undefined) this.fail("Expected a JSON value.");
    else this.fail(`Unexpected ${JSON.stringify(character)}; expected a JSON value.`);

    return node;
  }

  private parseObject(): JsonNode | undefined {
    const start = this.position;
    const entries: JsonObjectEntry[] = [];
    const keys = new Set<string>();
    this.position += 1;
    this.write("{");
    this.skipWhitespace();
    if (this.input[this.position] === "}") {
      this.position += 1;
      this.write("}");
      return this.buildTree ? { kind: "object", start, end: this.position, entries } : undefined;
    }

    this.depth += 1;
    let first = true;
    while (this.position < this.input.length) {
      if (!first) {
        if (this.input[this.position] !== ",")
          this.fail("Expected ',' or '}' after an object property.");
        this.position += 1;
        this.write(",");
        this.skipWhitespace();
        if (this.input[this.position] === "}") this.fail("Trailing commas are not valid JSON.");
      }
      this.writeLine();
      if (this.input[this.position] !== '"')
        this.fail("Expected a property name enclosed in double quotes.");
      const keyStart = this.position;
      const keyNode = this.parseString();
      const keyEnd = this.position;
      const key =
        keyNode?.kind === "string"
          ? keyNode.value
          : this.decodeString(this.input.slice(keyStart, keyEnd), keyStart);
      const duplicate = keys.has(key);
      if (duplicate) this.duplicateKeys += 1;
      else keys.add(key);
      this.skipWhitespace();
      if (this.input[this.position] !== ":") this.fail("Expected ':' after the property name.");
      this.position += 1;
      this.write(this.indent ? ": " : ":");
      this.skipWhitespace();
      const value = this.parseValue();
      if (this.buildTree && value) {
        entries.push({
          key,
          keyRaw: this.input.slice(keyStart, keyEnd),
          keyStart,
          keyEnd,
          duplicate,
          value,
        });
      }
      this.skipWhitespace();
      first = false;
      if (this.input[this.position] === "}") break;
    }
    this.depth -= 1;
    if (this.input[this.position] !== "}") this.fail("Expected '}' to close the object.");
    if (!first) this.writeLine();
    this.position += 1;
    this.write("}");
    return this.buildTree ? { kind: "object", start, end: this.position, entries } : undefined;
  }

  private parseArray(): JsonNode | undefined {
    const start = this.position;
    const items: JsonNode[] = [];
    this.position += 1;
    this.write("[");
    this.skipWhitespace();
    if (this.input[this.position] === "]") {
      this.position += 1;
      this.write("]");
      return this.buildTree ? { kind: "array", start, end: this.position, items } : undefined;
    }

    this.depth += 1;
    let first = true;
    while (this.position < this.input.length) {
      if (!first) {
        if (this.input[this.position] !== ",")
          this.fail("Expected ',' or ']' after an array item.");
        this.position += 1;
        this.write(",");
        this.skipWhitespace();
        if (this.input[this.position] === "]") this.fail("Trailing commas are not valid JSON.");
      }
      this.writeLine();
      const value = this.parseValue();
      if (this.buildTree && value) items.push(value);
      this.skipWhitespace();
      first = false;
      if (this.input[this.position] === "]") break;
    }
    this.depth -= 1;
    if (this.input[this.position] !== "]") this.fail("Expected ']' to close the array.");
    if (!first) this.writeLine();
    this.position += 1;
    this.write("]");
    return this.buildTree ? { kind: "array", start, end: this.position, items } : undefined;
  }

  private parseString(): JsonNode | undefined {
    const start = this.position;
    this.position += 1;
    while (this.position < this.input.length) {
      const code = this.input.charCodeAt(this.position);
      if (code === 34) {
        this.position += 1;
        const raw = this.input.slice(start, this.position);
        this.write(raw);
        return this.buildTree
          ? { kind: "string", start, end: this.position, raw, value: this.decodeString(raw, start) }
          : undefined;
      }
      if (code < 32) this.fail("Unescaped control character in string.");
      if (code === 92) {
        this.position += 1;
        const escapeCharacter = this.input[this.position];
        if (escapeCharacter === "u") {
          const digits = this.input.slice(this.position + 1, this.position + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("Invalid Unicode escape sequence.");
          this.position += 5;
          continue;
        }
        if (!escapeCharacter || !'"\\/bfnrt'.includes(escapeCharacter))
          this.fail("Invalid escape sequence.");
      }
      this.position += 1;
    }
    this.fail("Unterminated string.", start);
  }

  private decodeString(raw: string, offset: number) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      this.fail("Invalid string escape sequence.", offset);
    }
  }

  private parseNumber(): JsonNode | undefined {
    const start = this.position;
    if (this.input[this.position] === "-") this.position += 1;
    if (this.input[this.position] === "0") {
      this.position += 1;
      if (this.isDigit(this.input[this.position]))
        this.fail("Leading zeroes are not valid JSON numbers.");
    } else {
      if (!this.isDigitOneToNine(this.input[this.position]))
        this.fail("Expected a digit after '-'.");
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    if (this.input[this.position] === ".") {
      this.position += 1;
      if (!this.isDigit(this.input[this.position]))
        this.fail("Expected a digit after the decimal point.");
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    if (this.input[this.position] === "e" || this.input[this.position] === "E") {
      this.position += 1;
      if (this.input[this.position] === "+" || this.input[this.position] === "-")
        this.position += 1;
      if (!this.isDigit(this.input[this.position])) this.fail("Expected an exponent digit.");
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    const raw = this.input.slice(start, this.position);
    if (!raw.includes(".") && !/[eE]/.test(raw)) {
      try {
        const integer = BigInt(raw);
        if (
          integer > BigInt(Number.MAX_SAFE_INTEGER) ||
          integer < BigInt(Number.MIN_SAFE_INTEGER)
        ) {
          this.unsafeNumbers += 1;
        }
      } catch {
        this.fail("Invalid JSON number.", start);
      }
    }
    this.write(raw);
    return this.buildTree ? { kind: "number", start, end: this.position, raw } : undefined;
  }

  private parseLiteral(raw: "true" | "false", value: boolean): JsonNode | undefined {
    const start = this.position;
    if (this.input.slice(start, start + raw.length) !== raw) this.fail(`Expected '${raw}'.`);
    this.position += raw.length;
    this.write(raw);
    return this.buildTree ? { kind: "boolean", start, end: this.position, raw, value } : undefined;
  }

  private parseNull(): JsonNode | undefined {
    const start = this.position;
    if (this.input.slice(start, start + 4) !== "null") this.fail("Expected 'null'.");
    this.position += 4;
    this.write("null");
    return this.buildTree ? { kind: "null", start, end: this.position, raw: "null" } : undefined;
  }

  private isDigit(value: string | undefined) {
    return value !== undefined && value >= "0" && value <= "9";
  }

  private isDigitOneToNine(value: string | undefined) {
    return value !== undefined && value >= "1" && value <= "9";
  }
}

export function parseLosslessJson(
  input: string,
  options: ParserOptions & { buildTree: true },
): LosslessTreeResult;
export function parseLosslessJson(input: string, options?: ParserOptions): LosslessParseResult;
export function parseLosslessJson(input: string, options: ParserOptions = {}) {
  return new LosslessParser(input, options).parse();
}

export function indentToken(indent: 0 | 2 | 3 | 4 | "tab" | undefined): ParserOptions["indent"] {
  if (indent === 0) return "";
  if (indent === "tab") return "\t";
  return " ".repeat(indent ?? 2) as "  " | "   " | "    ";
}

export function formatLosslessJson(
  input: string,
  indent: 0 | 2 | 3 | 4 | "tab" | undefined,
): LosslessFormatResult {
  return parseLosslessJson(input, { indent: indentToken(indent) }) as LosslessFormatResult;
}

export function serializeJsonNode(
  node: JsonNode,
  indent: 0 | 2 | 3 | 4 | "tab" = 2,
  sortKeys = false,
  canonicalNumbers = false,
): string {
  const token = indentToken(indent);
  const render = (value: JsonNode, depth: number): string => {
    if (value.kind === "number" && canonicalNumbers) return canonicalJsonNumber(value.raw);
    if (
      value.kind === "string" ||
      value.kind === "number" ||
      value.kind === "boolean" ||
      value.kind === "null"
    ) {
      return value.raw;
    }
    const nextDepth = depth + 1;
    const padding = token ? `\n${token.repeat(nextDepth)}` : "";
    const closingPadding = token ? `\n${token.repeat(depth)}` : "";
    if (value.kind === "array") {
      if (!value.items.length) return "[]";
      return `[${padding}${value.items.map((item) => render(item, nextDepth)).join(`,${padding}`)}${closingPadding}]`;
    }
    if (!value.entries.length) return "{}";
    const entries = sortKeys
      ? value.entries
          .map((entry, index) => ({ entry, index }))
          .sort((left, right) =>
            left.entry.key < right.entry.key
              ? -1
              : left.entry.key > right.entry.key
                ? 1
                : left.index - right.index,
          )
      : value.entries.map((entry, index) => ({ entry, index }));
    const separator = token ? ": " : ":";
    return `{${padding}${entries
      .map(({ entry }) => `${entry.keyRaw}${separator}${render(entry.value, nextDepth)}`)
      .join(`,${padding}`)}${closingPadding}}`;
  };
  return render(node, 0);
}

export function canonicalJsonNumber(raw: string) {
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [mantissa, exponentRaw = "0"] = unsigned.toLowerCase().split("e");
  const decimal = mantissa.indexOf(".");
  let digits = mantissa.replace(".", "").replace(/^0+/, "");
  let scale = Number(exponentRaw) - (decimal === -1 ? 0 : mantissa.length - decimal - 1);
  if (!digits) return "0";
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale += 1;
  }
  return `${negative ? "-" : ""}${digits}e${scale}`;
}

export class LosslessNumber {
  readonly raw: string;

  constructor(raw: string) {
    this.raw = raw;
  }

  valueOf() {
    return Number(this.raw);
  }

  toString() {
    return this.raw;
  }
}

export type NativeJson =
  | null
  | boolean
  | number
  | string
  | bigint
  | LosslessNumber
  | NativeJson[]
  | { [key: string]: NativeJson };

export function jsonNodeToNative(node: JsonNode, preserveNumbers = false): NativeJson {
  switch (node.kind) {
    case "null":
      return null;
    case "boolean":
      return node.value;
    case "string":
      return node.value;
    case "number": {
      if (!preserveNumbers) return Number(node.raw);
      if (!node.raw.includes(".") && !/[eE]/.test(node.raw)) {
        const value = BigInt(node.raw);
        if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER))
          return Number(node.raw);
      }
      return new LosslessNumber(node.raw);
    }
    case "array":
      return node.items.map((item) => jsonNodeToNative(item, preserveNumbers));
    case "object": {
      const result: Record<string, NativeJson> = {};
      for (const entry of node.entries)
        result[entry.key] = jsonNodeToNative(entry.value, preserveNumbers);
      return result;
    }
  }
}

export function stringifyNativeLosslessly(
  value: unknown,
  indent: 0 | 2 | 3 | 4 | "tab" = 2,
): string {
  const token = indentToken(indent);
  const seen = new Set<object>();
  const render = (item: unknown, depth: number): string => {
    if (item instanceof LosslessNumber) return item.raw;
    if (item === null || typeof item === "boolean" || typeof item === "number")
      return JSON.stringify(item);
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "bigint") return item.toString();
    if (item === undefined) return "null";
    if (typeof item !== "object") return JSON.stringify(String(item));
    if (seen.has(item)) throw new TypeError("Cannot serialize a circular JSONPath result.");
    seen.add(item);
    const nextDepth = depth + 1;
    const padding = token ? `\n${token.repeat(nextDepth)}` : "";
    const closingPadding = token ? `\n${token.repeat(depth)}` : "";
    let result: string;
    if (Array.isArray(item)) {
      result = item.length
        ? `[${padding}${item.map((child) => render(child, nextDepth)).join(`,${padding}`)}${closingPadding}]`
        : "[]";
    } else {
      const entries = Object.entries(item as Record<string, unknown>);
      result = entries.length
        ? `{${padding}${entries
            .map(
              ([key, child]) =>
                `${JSON.stringify(key)}${token ? ": " : ":"}${render(child, nextDepth)}`,
            )
            .join(`,${padding}`)}${closingPadding}}`
        : "{}";
    }
    seen.delete(item);
    return result;
  };
  return render(value, 0);
}

export function findDeepestNodeAtOffset(node: JsonNode, offset: number): JsonNode {
  if (node.kind === "array") {
    for (const item of node.items) {
      if (offset >= item.start && offset <= item.end) return findDeepestNodeAtOffset(item, offset);
    }
  } else if (node.kind === "object") {
    for (const entry of node.entries) {
      if (offset >= entry.keyStart && offset <= entry.value.end) {
        return offset >= entry.value.start ? findDeepestNodeAtOffset(entry.value, offset) : node;
      }
    }
  }
  return node;
}
