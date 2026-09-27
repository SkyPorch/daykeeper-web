#!/usr/bin/env node
// Bundle budget (SPEC §5): the hosted messenger must stay at or under 40 KB
// gzip. Fails the check when it grows past the budget.
import { readFile } from "node:fs/promises";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const BUDGET_GZIP = 40 * 1024;
const file = fileURLToPath(new URL("../dist/messenger.js", import.meta.url));
const bytes = await readFile(file);
const gzip = gzipSync(bytes, { level: 9 }).length;
const brotli = brotliCompressSync(bytes).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(
  `messenger.js: ${kb(bytes.length)} raw, ${kb(gzip)} gzip, ${kb(brotli)} brotli (budget ${kb(BUDGET_GZIP)} gzip)`,
);
if (gzip > BUDGET_GZIP) {
  console.error("Bundle exceeds the 40 KB gzip budget.");
  process.exit(1);
}
