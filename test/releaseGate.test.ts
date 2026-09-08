import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
// @ts-expect-error The release verifier is an executable JavaScript module.
import { validateRelease } from "../scripts/verify-release.mjs";

test("the public release still fails closed without explicit approval", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.name, "@skyporch/daykeeper-web");
  assert.equal(manifest.private, false);
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
  assert.match(result.stderr, /immutable release tag/);
});

const contractBytes = Buffer.from("approved contract");
const checksum = createHash("sha256").update(contractBytes).digest("hex");
const valid = () => ({
  manifest: {
    name: "@skyporch/daykeeper-web",
    version: "0.2.0",
    private: false,
  },
  source: `\`customer.yaml\` is an exact copy of \`openapi/customer.yaml\` from\n\`SkyPorch/daykeeper-openapi\`, commit\n\`${"a".repeat(40)}\` (API-only channel contract).\n\n- SHA-256: \`${checksum}\`\n- Tag status: v0.2.0 (immutable release tag).`,
  changelog: "# Changelog\n\n## 0.2.0\n\n### Changes\n",
  contractBytes,
  env: {
    DAYKEEPER_RELEASE_APPROVED: "1",
    GITHUB_EVENT_NAME: "release",
    GITHUB_REF_NAME: "v0.2.0",
  },
});

test("release verifier requires approval and a non-private manifest", () => {
  const fixture = valid();
  fixture.manifest.private = true;
  assert.throws(() => validateRelease(fixture), /private must be false/);
  fixture.manifest.private = false;
  fixture.env.DAYKEEPER_RELEASE_APPROVED = "0";
  assert.throws(() => validateRelease(fixture), /DAYKEEPER_RELEASE_APPROVED/);
});

test("release verifier rejects untagged or incomplete contract provenance", () => {
  const fixture = valid();
  fixture.source = fixture.source.replace(
    "v0.2.0 (immutable release tag)",
    "unreleased commit snapshot",
  );
  assert.throws(() => validateRelease(fixture), /immutable release tag/);
  fixture.source = valid().source.replace("a".repeat(40), "a");
  assert.throws(
    () => validateRelease(fixture),
    /full immutable contract commit SHA/,
  );
  fixture.source = valid().source.replace(checksum, "b".repeat(64));
  assert.throws(() => validateRelease(fixture), /checksum does not match/);
});

test("release provenance cannot fall back to historical commits", () => {
  const fixture = valid();
  const history = `\n\nThe released baseline is tag v1.0.0, commit\n\`${"b".repeat(40)}\`.`;
  fixture.source += history;
  assert.equal(validateRelease(fixture).contractCommit, "a".repeat(40));
  fixture.source = valid().source.replace("a".repeat(40), "a4f1239") + history;
  assert.throws(
    () => validateRelease(fixture),
    /full immutable contract commit SHA/,
  );
  fixture.source =
    valid().source.replace(/commit\s+`a+`/, "commit unavailable") + history;
  assert.throws(
    () => validateRelease(fixture),
    /full immutable contract commit SHA/,
  );
  fixture.source = valid().source + "\n\n" + valid().source;
  assert.throws(
    () => validateRelease(fixture),
    /full immutable contract commit SHA/,
  );
});

test("active provenance cannot borrow historical tag or checksum fields", () => {
  const fixture = valid();
  const history = `\n\n## Historical release\n\n- Tag status: v0.1.0 (immutable release tag).\n- SHA-256: \`${checksum}\`\n`;
  fixture.source = valid().source.replace(/^- Tag status:.*$/m, "") + history;
  assert.throws(() => validateRelease(fixture), /immutable release tag/);
  fixture.source = valid().source.replace(/^- SHA-256:.*\n/m, "") + history;
  assert.throws(() => validateRelease(fixture), /full contract checksum/);
  fixture.source = valid().source + `\n- SHA-256: \`${checksum}\``;
  assert.throws(() => validateRelease(fixture), /full contract checksum/);
  fixture.source = valid().source + history;
  assert.doesNotThrow(() => validateRelease(fixture));
});

test("release verifier requires a finalized version changelog and matching tag", () => {
  const fixture = valid();
  fixture.changelog = "# Changelog\n\n## 0.2.0 — unreleased\n";
  assert.throws(() => validateRelease(fixture), /finalized heading/);
  fixture.changelog = valid().changelog;
  fixture.env.GITHUB_REF_NAME = "v0.2.1";
  assert.throws(() => validateRelease(fixture), /Git tag must match/);
});

test("release verifier accepts a manual dry-run branch ref", () => {
  const fixture = valid();
  fixture.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  fixture.env.GITHUB_REF_NAME = "main";
  assert.doesNotThrow(() => validateRelease(fixture));
});
