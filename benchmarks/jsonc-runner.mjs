import { readFileSync } from "node:fs";
import { applyEdits, format } from "jsonc-parser";

const input = readFileSync(0, "utf8");
const edits = format(input, undefined, {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
  keepLines: false,
});
process.stdout.write(applyEdits(input, edits));
