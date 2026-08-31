import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await discover(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts"))
      files.push(path);
  }
  return files.sort();
}

// Node 20 does not expand test globs. Resolve paths without relying on the
// caller's shell so all supported Node versions execute the same test files.
const files = await discover(join(root, "test"));
assert(files.length > 0, "No SDK test files found");
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
  timeout: 120_000,
});
child.on("error", () => {
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
