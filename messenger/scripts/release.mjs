#!/usr/bin/env node
// Assemble the CDN release directory for cdn.mydaykeeper.com:
//   release/messenger/<version>/messenger.js   immutable, 1-year cache
//   release/messenger/v1/messenger.js          alias, max-age=300
// plus the SRI hash for the immutable URL. Serving headers (CORS *, nosniff,
// cache-control) belong to the Caddy site; see messenger/README.md.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(`${root}package.json`, "utf8"));
const major =
  version.split(".")[0] === "0" ? "v1" : `v${version.split(".")[0]}`;

const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);
const sized = spawnSync(process.execPath, ["scripts/size.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (sized.status !== 0) process.exit(sized.status ?? 1);

const bundle = await readFile(`${root}dist/messenger.js`);
// The CDN copy carries no sourceMappingURL: maps are kept with the release
// record, not served.
const text = bundle
  .toString("utf8")
  .replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");
const bytes = Buffer.from(text, "utf8");
const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const out = `${root}release/messenger`;
await rm(`${root}release`, { recursive: true, force: true });
await mkdir(`${out}/${version}`, { recursive: true });
await mkdir(`${out}/${major}`, { recursive: true });
await writeFile(`${out}/${version}/messenger.js`, bytes);
await writeFile(`${out}/${major}/messenger.js`, bytes);
await copyFile(
  `${root}dist/messenger.js.map`,
  `${root}release/messenger-${version}.js.map`,
);
const manifest = {
  version,
  file: `messenger/${version}/messenger.js`,
  alias: `messenger/${major}/messenger.js`,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity,
};
await writeFile(
  `${root}release/manifest.json`,
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest, null, 2));
console.log(`
Pinned snippet (immutable URL + SRI):
<script async src="https://cdn.mydaykeeper.com/messenger/${version}/messenger.js"
  integrity="${integrity}" crossorigin="anonymous"></script>`);
