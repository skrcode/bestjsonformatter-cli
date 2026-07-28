import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("dist/cli.js");
const packageVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version;

async function run(args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const exact = String.raw`{"id":9007199254740993,"tiny":1.2300e-40,"escaped":"\u0061","mode":"first","mode":"second"}`;

const version = await run(["--version"]);
assert.equal(version.code, 0);
assert.equal(version.stdout.trim(), packageVersion);

const formatted = await run(["format", "-", "--indent", "2"], exact);
assert.equal(formatted.code, 0);
assert.match(formatted.stdout, /9007199254740993/);
assert.match(formatted.stdout, /1\.2300e-40/);
assert.match(formatted.stdout, /\\u0061/);
assert.equal(formatted.stdout.match(/"mode"/g)?.length, 2);

const checked = await run(["check", "-", "--json"], exact);
assert.equal(checked.code, 1);
const report = JSON.parse(checked.stdout);
assert.equal(report.valid, true);
assert.deepEqual(
  report.issues.map((issue) => issue.code),
  ["unsafe-number", "number-spelling", "duplicate-key"],
);

const invalid = await run(["validate", "-"], '{"broken":}');
assert.equal(invalid.code, 1);
assert.match(invalid.stderr, /<stdin>:1:11/);

const directory = await mkdtemp(join(tmpdir(), "bestjsonformatter-smoke-"));
const documentPath = join(directory, "document.json");
await writeFile(documentPath, '{"z":2,"a":1}', "utf8");
const writeResult = await run(["format", documentPath, "--write", "--quiet"]);
assert.equal(writeResult.code, 0);
assert.equal(await readFile(documentPath, "utf8"), '{\n  "z": 2,\n  "a": 1\n}\n');

console.log("CLI smoke test passed.");
