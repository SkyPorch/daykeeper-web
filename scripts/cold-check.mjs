import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, toolEnvironment } from "./run.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".smoke"), { recursive: true });
const directory = await mkdtemp(join(root, ".smoke/cold-"));
const source = join(directory, "source");
const store = join(directory, "empty-store");
await mkdir(source);
await mkdir(store);
assert.deepEqual(await readdir(store), [], "Dependency store must start empty");
const names = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  ".gitignore",
  ".prettierignore",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "COMPATIBILITY.md",
  "CONTRIBUTING.md",
  "RELEASING.md",
  "src",
  "test",
  "scripts",
  "openapi",
];
async function copyChecked(from, to) {
  const info = await lstat(from);
  assert(
    !info.isSymbolicLink(),
    "Cold source must not follow symlinks into a shared dependency tree",
  );
  if (info.isDirectory()) {
    await mkdir(to);
    for (const name of await readdir(from))
      await copyChecked(join(from, name), join(to, name));
  } else {
    assert(info.isFile());
    await copyFile(from, to);
  }
}
for (const name of names)
  await copyChecked(join(root, name), join(source, name));
assert(!(await readdir(source)).includes("node_modules"));
const originalLock = await readFile(join(root, "pnpm-lock.yaml"));
const lockHash = createHash("sha256").update(originalLock).digest("hex");
const env = toolEnvironment(join(directory, "npm-cache"));
console.log(
  `Cold reproducibility check: empty store, frozen lock, isolated source (${directory})`,
);
const installation = await run(
  "pnpm",
  [
    "install",
    "--frozen-lockfile",
    "--registry=https://registry.npmjs.org",
    "--store-dir",
    store,
    `--config.cache-dir=${join(directory, "pnpm-cache")}`,
  ],
  { cwd: source, env, timeout: 180_000 },
);
await writeFile(
  join(directory, "install.log"),
  installation.stdout + installation.stderr,
);
assert.deepEqual(
  await readFile(join(source, "pnpm-lock.yaml")),
  originalLock,
  "Cold install modified the frozen lockfile",
);
console.log(
  "Cold dependencies installed; running the complete SDK/packed-consumer checks...",
);
const check = await run("pnpm", ["check"], {
  cwd: source,
  env,
  timeout: 180_000,
});
await writeFile(join(directory, "check.log"), check.stdout + check.stderr);
const packed = JSON.parse(
  await readFile(join(source, ".smoke/latest-package.json"), "utf8"),
);
let previous;
try {
  previous = JSON.parse(
    await readFile(join(root, ".smoke/latest-package.json"), "utf8"),
  );
} catch {
  throw new Error(
    "Run pnpm check before check:cold so tarball reproducibility has a baseline",
  );
}
assert.equal(
  packed.tarballSha256,
  previous.tarballSha256,
  "Warm and cold builds produced different tarballs",
);
const result = {
  node: process.version,
  lockSha256: lockHash,
  initiallyEmptyStore: true,
  frozenLockUnchanged: true,
  tarballSha256: packed.tarballSha256,
  identicalToBaseline: true,
  checks: packed.checks,
  directory,
};
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(result, null, 2),
);
await writeFile(
  join(root, ".smoke/latest-cold.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
