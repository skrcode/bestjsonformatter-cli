import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  type JsonNode,
  jsonNodeToNative,
  parseLosslessJson,
  stringifyNativeLosslessly,
} from "./lossless-json.js";

type JsonSchema = Record<string, unknown>;

function stableSchemaKey(schema: JsonSchema) {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(schema));
}

function inferNode(node: JsonNode): JsonSchema {
  switch (node.kind) {
    case "null":
      return { type: "null" };
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "number":
      return { type: node.raw.includes(".") || /[eE]/.test(node.raw) ? "number" : "integer" };
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const entry of node.entries) {
        if (!(entry.key in properties)) required.push(entry.key);
        properties[entry.key] = inferNode(entry.value);
      }
      return { type: "object", properties, required };
    }
    case "array": {
      if (!node.items.length) return { type: "array" };
      const unique = new Map<string, JsonSchema>();
      for (const item of node.items) {
        const schema = inferNode(item);
        unique.set(stableSchemaKey(schema), schema);
      }
      const schemas = [...unique.values()];
      return {
        type: "array",
        items: schemas.length === 1 ? schemas[0] : { anyOf: schemas },
      };
    }
  }
}

export function inferJsonSchema(input: string) {
  const parsed = parseLosslessJson(input, { buildTree: true });
  return {
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...inferNode(parsed.root),
    },
    metadata: parsed.metadata,
  };
}

function formatError(error: ErrorObject) {
  const path = error.instancePath || "/";
  const message = error.message ?? "does not satisfy the schema";
  return `${path} ${message}`;
}

export async function validateJsonSchema(input: string, schemaInput: string) {
  const document = parseLosslessJson(input, { buildTree: true });
  const schema = parseLosslessJson(schemaInput, { buildTree: true });
  if (schema.root?.kind !== "object") {
    throw new TypeError("The JSON Schema must be an object.");
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(jsonNodeToNative(schema.root, false) as object);
  const valid = validate(jsonNodeToNative(document.root, false));
  const errors = valid ? [] : (validate.errors ?? []).map(formatError);

  return {
    valid: Boolean(valid),
    errors,
    metadata: {
      duplicateKeys: document.metadata.duplicateKeys + schema.metadata.duplicateKeys,
      unsafeNumbers: document.metadata.unsafeNumbers,
      schemaErrors: errors.length,
    },
  };
}

function resolveLocalReference(root: Record<string, unknown>, reference: string) {
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .reduce<unknown>((value, segment) => {
      if (!value || typeof value !== "object") return undefined;
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      return (value as Record<string, unknown>)[key];
    }, root);
}

function sampleForSchema(
  schema: unknown,
  root: Record<string, unknown>,
  references: Set<string>,
  depth = 0,
): unknown {
  if (!schema || typeof schema !== "object" || depth > 50) return null;
  const current = schema as Record<string, unknown>;
  if ("const" in current) return current.const;
  if ("default" in current) return current.default;
  if (Array.isArray(current.examples) && current.examples.length) return current.examples[0];
  if (Array.isArray(current.enum) && current.enum.length) return current.enum[0];
  if (typeof current.$ref === "string") {
    if (references.has(current.$ref)) return null;
    const target = resolveLocalReference(root, current.$ref);
    if (target !== undefined) {
      const nextReferences = new Set(references);
      nextReferences.add(current.$ref);
      return sampleForSchema(target, root, nextReferences, depth + 1);
    }
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const alternatives = current[keyword];
    if (Array.isArray(alternatives) && alternatives.length) {
      return sampleForSchema(alternatives[0], root, references, depth + 1);
    }
  }
  if (Array.isArray(current.allOf)) {
    const merged = Object.assign(
      {},
      ...current.allOf
        .map((part) => sampleForSchema(part, root, references, depth + 1))
        .filter((part) => part && typeof part === "object" && !Array.isArray(part)),
    );
    if (Object.keys(merged).length) return merged;
  }

  const type = Array.isArray(current.type)
    ? (current.type.find((value) => value !== "null") ?? current.type[0])
    : current.type;
  if (type === "object" || current.properties) {
    const properties =
      current.properties && typeof current.properties === "object"
        ? (current.properties as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, child]) => [
        key,
        sampleForSchema(child, root, references, depth + 1),
      ]),
    );
  }
  if (type === "array" || current.items) {
    return current.items ? [sampleForSchema(current.items, root, references, depth + 1)] : [];
  }
  if (type === "integer") {
    const minimum = Number(current.minimum ?? current.exclusiveMinimum ?? 0);
    return Number.isFinite(minimum) ? Math.ceil(minimum) : 0;
  }
  if (type === "number") {
    const minimum = Number(current.minimum ?? current.exclusiveMinimum ?? 0);
    return Number.isFinite(minimum) ? minimum : 0;
  }
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (type === "string" || current.format || current.minLength) {
    const formatSamples: Record<string, string> = {
      date: "2026-01-01",
      "date-time": "2026-01-01T00:00:00Z",
      email: "user@example.com",
      hostname: "example.com",
      ipv4: "192.0.2.1",
      uri: "https://example.com/",
      uuid: "00000000-0000-4000-8000-000000000000",
    };
    if (typeof current.format === "string" && formatSamples[current.format]) {
      return formatSamples[current.format];
    }
    return "x".repeat(Math.min(100, Math.max(0, Number(current.minLength ?? 0))));
  }
  return null;
}

export function generateJsonSample(schemaInput: string) {
  const schema = parseLosslessJson(schemaInput, { buildTree: true });
  if (schema.root?.kind !== "object") throw new TypeError("The JSON Schema must be an object.");
  const nativeSchema = jsonNodeToNative(schema.root, true) as Record<string, unknown>;
  const sample = sampleForSchema(nativeSchema, nativeSchema, new Set());
  return {
    value: stringifyNativeLosslessly(sample, 2),
    metadata: schema.metadata,
  };
}
