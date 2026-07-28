import { spawn } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url))],
    { stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`TypeScript build exited with code ${code ?? "unknown"}.`));
  });
});

await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
console.log("Built dist/cli.js and the public library.");
