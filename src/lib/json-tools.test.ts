import { describe, expect, it } from "vitest";
import { parseJson, runTool } from "./json-tools.js";

describe("JSON tools", () => {
  it("formats with the selected indentation", async () => {
    const result = await runTool({ operation: "format", input: '{"ok":true}', indent: 4 });
    expect(result.ok && result.value).toBe('{\n    "ok": true\n}');
    expect(result.metadata?.inputBytes).toBe(11);
    expect(result.metadata?.outputBytes).toBe(18);
  });

  it("formats compact JSON without a separate minify action", async () => {
    const result = await runTool({ operation: "format", input: '{ "ok": true }', indent: 0 });
    expect(result.ok && result.value).toBe('{"ok":true}');
  });

  it("supports three-space indentation", async () => {
    const result = await runTool({ operation: "format", input: '{"ok":true}', indent: 3 });
    expect(result.ok && result.value).toBe('{\n   "ok": true\n}');
  });

  it("sorts object keys recursively without reordering arrays", async () => {
    const result = await runTool({
      operation: "sort",
      input: '{"z":{"b":2,"a":1},"a":[{"d":4,"c":3},2]}',
      indent: 0,
    });
    expect(result.ok && result.value).toBe('{"a":[{"c":3,"d":4},2],"z":{"a":1,"b":2}}');
  });

  it("returns a useful location for invalid input", () => {
    const result = parseJson('{"ok": }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(3);
  });

  it("repairs common JSON mistakes", async () => {
    const result = await runTool({ operation: "repair", input: "{name: 'Ada',}" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value)).toEqual({ name: "Ada" });
  });

  it("converts arrays of objects to CSV", async () => {
    const result = await runTool({ operation: "csv", input: '[{"name":"Ada","active":true}]' });
    expect(result.ok && result.value).toContain("name,active");
  });

  it("converts JSON to escaped XML", async () => {
    const result = await runTool({ operation: "xml", input: '{"first name":"Ada & Lin"}' });
    expect(result.ok && result.value).toContain('<item key="first name">Ada &amp; Lin</item>');
  });

  it("preserves exact JSON numbers when converting to YAML", async () => {
    const result = await runTool({
      operation: "yaml",
      input: '{"id":9007199254740993,"tiny":1.2300e-40,"huge":9E+400}',
    });
    expect(result.ok && result.value).toContain("id: 9007199254740993");
    expect(result.ok && result.value).toContain("tiny: 1.2300e-40");
    expect(result.ok && result.value).toContain("huge: 9E+400");
  });

  it("rejects incompatible CSV data", async () => {
    const result = await runTool({ operation: "csv", input: '{"name":"Ada"}' });
    expect(result.ok).toBe(false);
  });

  it("runs JSONPath queries", async () => {
    const result = await runTool({
      operation: "jsonpath",
      input: '{"items":[1,2]}',
      query: "$.items[*]",
    });
    expect(result.ok && result.value).toContain("2");
    expect(result.metadata?.results).toBe(2);
  });

  it("compares parsed JSON structurally with readable line-level changes", async () => {
    const result = await runTool({
      operation: "compare",
      input: '{"version":1,"nested":{"enabled":true}}',
      secondaryInput: '{"version":2,"nested":{"enabled":false,"added":null}}',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("--- Original\n+++ Changed");
    expect(result.value).toContain('-     "enabled": true');
    expect(result.value).toContain('+     "added": null,');
    expect(result.value).toContain('+     "enabled": false');
    expect(result.value).not.toContain('- {"version":1');
    expect(result.metadata).toMatchObject({ identical: false });
  });

  it("ignores formatting and object-key order when comparing JSON", async () => {
    const result = await runTool({
      operation: "compare",
      input: '{\n  "b": 2,\n  "a": 1\n}',
      secondaryInput: '{"a":1,"b":2}',
    });

    expect(result.ok && result.value).toBe(
      "No structural differences. The JSON documents are equivalent.",
    );
    expect(result.metadata).toMatchObject({ additions: 0, removals: 0, identical: true });
  });

  it("reports which compare input is invalid", async () => {
    const result = await runTool({
      operation: "compare",
      input: '{"valid":true}',
      secondaryInput: '{"broken":}',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^Second document:/);
  });

  it("never rounds integers or rewrites valid number lexemes", async () => {
    const input = '{"id":9007199254740993,"tiny":1.2300e-40,"huge":9E+400}';
    const formatted = await runTool({ operation: "format", input, indent: 2 });
    const minified = await runTool({ operation: "minify", input });

    expect(formatted.ok && formatted.value).toContain("9007199254740993");
    expect(formatted.ok && formatted.value).toContain("1.2300e-40");
    expect(formatted.ok && formatted.value).toContain("9E+400");
    expect(formatted.metadata).toMatchObject({ unsafeNumbers: 1 });
    expect(minified.ok && minified.value).toBe(input);
  });

  it("preserves duplicate properties and reports them without discarding data", async () => {
    const input = '{"mode":"first","mode":"second"}';
    const result = await runTool({ operation: "format", input, indent: 2 });

    expect(result.ok && result.value.match(/"mode"/g)).toHaveLength(2);
    expect(result.metadata).toMatchObject({ duplicateKeys: 1 });
  });

  it("reports duplicate property paths and every source location", async () => {
    const result = await runTool({
      operation: "duplicates",
      input: '{\n  "user": {"id": 1, "id": 2},\n  "mode": "a",\n  "mode": "b"\n}',
    });

    expect(result.ok && result.value).toContain("2 duplicate property groups found.");
    expect(result.ok && result.value).toContain("$.user.id");
    expect(result.ok && result.value).toContain("$.mode");
    expect(result.ok && result.value).toContain("line 2");
    expect(result.metadata).toMatchObject({ duplicateKeys: 2, results: 2 });
  });

  it("reports JavaScript number rounding, overflow, and notation changes", async () => {
    const result = await runTool({
      operation: "precision",
      input: '{"id":9007199254740993,"huge":9E+400,"notation":1.2300e-40,"safe":42}',
    });

    expect(result.ok && result.value).toContain("$.id");
    expect(result.ok && result.value).toContain("rounds to 9007199254740992");
    expect(result.ok && result.value).toContain("$.huge");
    expect(result.ok && result.value).toContain("becomes Infinity");
    expect(result.ok && result.value).toContain("$.notation");
    expect(result.ok && result.value).toContain("normalizes its spelling");
    expect(result.ok && result.value).not.toContain("$.safe");
    expect(result.metadata).toMatchObject({ unsafeNumbers: 1, results: 3 });
  });

  it("preserves the original spelling of escaped strings", async () => {
    const input = String.raw`{"escaped":"\u0061\/b","control":"\n"}`;
    const result = await runTool({ operation: "format", input, indent: 0 });
    expect(result.ok && result.value).toBe(input);
  });

  it("reports deterministic line, column, and offset locations", async () => {
    const result = await runTool({ operation: "validate", input: '{\n  "ok": true,\n  broken\n}' });
    expect(result).toMatchObject({
      ok: false,
      line: 3,
      column: 3,
      offset: 18,
    });
  });

  it("handles a large correctness corpus without truncating output", async () => {
    const input = `[${Array.from(
      { length: 20_000 },
      (_, index) => `{"id":${BigInt("9007199254740993") + BigInt(index)},"value":"row-${index}"}`,
    ).join(",")}]`;
    const result = await runTool({ operation: "format", input, indent: 0 });

    expect(result.ok && result.value).toBe(input);
    expect(result.metadata).toMatchObject({ unsafeNumbers: 20_000 });
  });

  it("compares numerically equivalent JSON numbers as equal", async () => {
    const result = await runTool({
      operation: "compare",
      input: '{"a":1e2,"b":1.0,"c":-0}',
      secondaryInput: '{"c":0,"b":1,"a":100.00}',
    });
    expect(result.ok && result.value).toBe(
      "No structural differences. The JSON documents are equivalent.",
    );
  });

  it("infers Draft 2020-12 JSON Schema", async () => {
    const result = await runTool({
      operation: "schema",
      input: '{"id":9007199254740993,"name":"Ada","tags":["a"]}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const schema = JSON.parse(result.value);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.id.type).toBe("integer");
    expect(schema.properties.tags.items.type).toBe("string");
    expect(result.metadata).toMatchObject({ unsafeNumbers: 1 });
  });

  it("validates JSON against Draft 2020-12 schema with all errors", async () => {
    const result = await runTool({
      operation: "schema_validate",
      input: '{"id":3,"email":"not-an-email"}',
      secondaryInput: JSON.stringify({
        type: "object",
        required: ["id", "email"],
        properties: {
          id: { type: "integer", minimum: 5 },
          email: { type: "string", format: "email" },
        },
      }),
    });
    expect(result.ok && result.value).toContain("/id must be >= 5");
    expect(result.ok && result.value).toContain('/email must match format "email"');
    expect(result.metadata).toMatchObject({ schemaValid: false, schemaErrors: 2 });
  });

  it("generates a useful JSON sample from Draft 2020-12 schema", async () => {
    const result = await runTool({
      operation: "schema_sample",
      input:
        '{"type":"object","properties":{"id":{"const":9007199254740993},"email":{"type":"string","format":"email"},"tags":{"type":"array","items":{"enum":["fast","safe"]}}}}',
    });
    expect(result.ok && result.value).toContain('"id": 9007199254740993');
    expect(result.ok && result.value).toContain('"email": "user@example.com"');
    expect(result.ok && result.value).toContain('"fast"');
  });
});
