import { describe, expect, it } from "vitest";
import { checkJson } from "./json-check.js";

describe("checkJson", () => {
  it("checks duplicate keys and every number risk in one parse", () => {
    const result = checkJson(
      '{"id":9007199254740993,"tiny":1.2300e-40,"huge":9E+400,"mode":"a","mode":"b"}',
    );

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.clean).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unsafe-number",
      "number-spelling",
      "number-overflow",
      "duplicate-key",
    ]);
    expect(result.issues.at(-1)?.locations).toHaveLength(2);
  });

  it("returns deterministic syntax locations", () => {
    expect(checkJson('{\n  "ok": true,\n  broken\n}')).toMatchObject({
      valid: false,
      line: 3,
      column: 3,
      offset: 18,
    });
  });

  it("accepts safe JSON without findings", () => {
    expect(checkJson('{"name":"Ada","active":true,"items":[1,2,3]}')).toMatchObject({
      valid: true,
      clean: true,
      issues: [],
    });
  });
});
