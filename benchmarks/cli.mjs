import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const runs = Number(process.env.BENCHMARK_RUNS ?? 5);
const sampleTimeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS ?? 15_000);
const row = '{"id":9007199254740993,"value":"benchmark-row"}';
const targets = [128, 100 * 1024, 1024 * 1024, 5 * 1024 * 1024];
const biome = resolve("node_modules/@biomejs/biome/bin/biome");
const prettier = resolve("node_modules/prettier/bin/prettier.cjs");
const jsoncRunner = resolve("benchmarks/jsonc-runner.mjs");
const cli = resolve("dist/cli.js");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim() || result.stderr.trim() : undefined;
}

const competitors = [
  {
    name: "Best JSON Formatter",
    version: packageJson.version,
    command: process.execPath,
    args: [cli, "format", "-", "--indent", "2"],
    fullyLossless: true,
  },
  {
    name: "Biome",
    version: packageJson.devDependencies["@biomejs/biome"],
    command: biome,
    args: [
      "format",
      "--stdin-file-path=benchmark.json",
      "--indent-style=space",
      "--indent-width=2",
      "--line-width=80",
      "--trailing-newline=false",
      "--files-max-size=8000000",
    ],
    fullyLossless: false,
  },
  {
    name: "Prettier",
    version: packageJson.devDependencies.prettier,
    command: process.execPath,
    args: [prettier, "--parser", "json", "--tab-width", "2"],
    fullyLossless: false,
  },
  {
    name: "jsonc-parser",
    version: packageJson.devDependencies["jsonc-parser"],
    command: process.execPath,
    args: [jsoncRunner],
    fullyLossless: true,
  },
  {
    name: "Node JSON.parse/stringify",
    version: process.version,
    command: process.execPath,
    args: [
      "-e",
      'const fs=require("node:fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")),null,2))',
    ],
    fullyLossless: false,
  },
];

const jqCommand = process.env.JQ_BIN ?? "jq";
const jqVersion = commandVersion(jqCommand, ["--version"]);
if (jqVersion) {
  competitors.push({
    name: "jq",
    version: jqVersion,
    command: jqCommand,
    args: ["."],
    fullyLossless: false,
  });
}

const pythonVersion = commandVersion("python3", ["--version"]);
if (pythonVersion) {
  competitors.push({
    name: "Python json.tool",
    version: pythonVersion,
    command: "python3",
    args: ["-m", "json.tool", "--indent", "2"],
    fullyLossless: false,
  });
}

function execute(competitor, input, captureOutput = false) {
  const result = spawnSync(competitor.command, competitor.args, {
    input,
    encoding: captureOutput ? "utf8" : undefined,
    stdio: captureOutput ? ["pipe", "pipe", "pipe"] : ["pipe", "ignore", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
    timeout: sampleTimeoutMs,
  });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    const error = new Error(`${competitor.name} exceeded ${sampleTimeoutMs} ms.`);
    error.name = "BenchmarkTimeout";
    throw error;
  }
  if (result.status !== 0) {
    const error = result.stderr?.toString() || `exit ${result.status}`;
    throw new Error(`${competitor.name} failed: ${error}`);
  }
  return captureOutput ? result.stdout : "";
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

const exactnessInput = String.raw`{"large":9007199254740993,"decimal":1.2300e-40,"escaped":"\u0061\/b","mode":"first","mode":"second"}`;
const exactness = competitors.map((competitor) => {
  const output = execute(competitor, exactnessInput, true);
  return {
    name: competitor.name,
    version: competitor.version,
    declaredFullyLossless: competitor.fullyLossless,
    preservesLargeInteger: output.includes("9007199254740993"),
    preservesNumberSpelling: output.includes("1.2300e-40"),
    preservesEscapeSpelling: output.includes(String.raw`\u0061\/b`),
    preservesDuplicateKeys: output.match(/"mode"/g)?.length === 2,
  };
});

const timings = [];
for (const target of targets) {
  const payload = `{"items":[${Array(Math.max(1, Math.ceil(target / row.length)))
    .fill(row)
    .join(",")}]}`;
  for (const competitor of competitors) {
    const samples = [];
    let timedOut = false;
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now();
      try {
        execute(competitor, payload);
      } catch (error) {
        if (error instanceof Error && error.name === "BenchmarkTimeout") {
          timedOut = true;
          break;
        }
        throw error;
      }
      samples.push(Math.round(performance.now() - started));
    }
    timings.push({
      name: competitor.name,
      version: competitor.version,
      payloadBytes: Buffer.byteLength(payload),
      samples,
      timedOut,
      sampleTimeoutMs,
      medianMs: timedOut ? null : percentile(samples, 0.5),
      p95Ms: timedOut ? null : percentile(samples, 0.95),
    });
  }
}

const report = {
  date: new Date().toISOString(),
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    runs,
    sampleTimeoutMs,
  },
  method:
    "Fresh process per sample; identical stdin payload; formatted stdout discarded; no artificial throttling.",
  exactness,
  timings,
};

const outputPath = resolve("benchmark-results/latest.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
