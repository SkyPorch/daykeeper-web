import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the private foundation fails closed before publication", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.name, "@skyporch/daykeeper-web");
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.equal(
    manifest.scripts.prepublishOnly,
    "node scripts/verify-release.mjs",
  );
  const result = spawnSync(process.execPath, ["scripts/verify-release.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publication is disabled/);
});
