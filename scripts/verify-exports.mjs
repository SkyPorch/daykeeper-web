import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(manifest.name, "@skyporch/daykeeper-web");
assert.equal(manifest.license, "MIT");
assert.equal(manifest.sideEffects, false);
assert.deepEqual(manifest.dependencies ?? {}, {});
assert.equal(manifest.exports["."].import.types, "./dist/index.d.ts");
assert.equal(manifest.exports["."].require.types, "./dist/index.d.cts");
assert.equal(manifest.exports["."].import.default, manifest.module);
assert.equal(manifest.exports["."].require.default, manifest.main);
const esm = await import("../dist/index.js");
const cjs = createRequire(import.meta.url)("../dist/index.cjs");
const callables = [
  "createDaykeeperWebClient",
  "DaykeeperWebClient",
  "DaykeeperWebApiError",
  "DaykeeperWebTransportError",
  "isDaykeeperApiErrorCode",
];
const constants = { DAYKEEPER_GENERIC_API_CODE: "daykeeper_request_failed" };
const names = [...callables, ...Object.keys(constants)].sort();
for (const entry of [esm, cjs]) {
  assert.deepEqual(Object.keys(entry).sort(), names);
  for (const name of callables) assert.equal(typeof entry[name], "function");
  for (const [name, value] of Object.entries(constants))
    assert.equal(entry[name], value);
}
for (const file of ["index.js", "index.cjs"]) {
  const source = await readFile(
    new URL(`../dist/${file}`, import.meta.url),
    "utf8",
  );
  assert(
    !/\b(?:process|Buffer)\b|node:|\brequire\s*\(/.test(source),
    "Runtime bundle must not require Node globals or builtin imports",
  );
  assert(
    !/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(source),
    "Runtime bundle must not persist credentials",
  );
}
console.log("ESM/CJS exports, declarations and browser-only runtime verified");
