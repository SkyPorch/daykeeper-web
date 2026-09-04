#!/usr/bin/env node
// Verify that `npm pack` is reproducible and that the published file list is
// clean. Runs the pack twice into separate temp directories, extracts both,
// and compares the file list plus the SHA-256 of every entry's contents. The
// tarball bytes themselves are deliberately not hashed: gzip embeds a
// timestamp, so identical content produces different tarball digests.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const FORBIDDEN = [
  { label: "test/", test: (p) => p.split("/").includes("test") },
  { label: "tests/", test: (p) => p.split("/").includes("tests") },
  { label: "__tests__/", test: (p) => p.split("/").includes("__tests__") },
  { label: "fixtures/", test: (p) => p.split("/").includes("fixtures") },
  { label: "smoke/", test: (p) => p.split("/").includes("smoke") },
  {
    label: "*.test.*",
    test: (p) => /(^|\/)[^/]+\.test\.[^/]+$/.test(p),
  },
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join("/"));
    } else {
      fail(`Pack contains a non-regular file: ${relative(base, full)}`);
    }
  }
  return out.sort();
}

// Pack into `dir`, extract the tarball, and return { files, digests }.
function packAndExtract(dir) {
  const stdout = run(npm, ["pack", "--pack-destination", dir], repoRoot);
  const tarballs = readdirSync(dir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected exactly one tarball in ${dir}, found ${tarballs.length}.\n${stdout}`,
    );
  }
  const extractDir = join(dir, "extracted");
  run("mkdir", ["-p", extractDir], repoRoot);
  run("tar", ["-x", "-f", join(dir, tarballs[0]), "-C", extractDir], repoRoot);
  const root = join(extractDir, "package");
  const files = walk(root);
  const digests = new Map();
  for (const file of files) {
    digests.set(
      file,
      createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex"),
    );
  }
  return { files, digests, root };
}

const dirs = [];
try {
  for (let i = 0; i < 2; i += 1) {
    dirs.push(mkdtempSync(join(tmpdir(), "daykeeper-web-pack-")));
  }
  const [first, second] = dirs.map((dir) => packAndExtract(dir));

  // 1. Reproducibility: same file list, same content digests.
  const onlyFirst = first.files.filter((f) => !second.digests.has(f));
  const onlySecond = second.files.filter((f) => !first.digests.has(f));
  for (const file of onlyFirst) {
    fail(`Pack is not reproducible: ${file} present in run 1 only`);
  }
  for (const file of onlySecond) {
    fail(`Pack is not reproducible: ${file} present in run 2 only`);
  }
  for (const file of first.files) {
    const a = first.digests.get(file);
    const b = second.digests.get(file);
    if (b !== undefined && a !== b) {
      fail(`Pack is not reproducible: ${file}\n  run 1 ${a}\n  run 2 ${b}`);
    }
  }

  // 2. No test or fixture material may reach the registry.
  for (const file of first.files) {
    for (const rule of FORBIDDEN) {
      if (rule.test(file)) {
        fail(`Packed file matches forbidden pattern ${rule.label}: ${file}`);
      }
    }
  }

  // 3. Source maps must not point outside the published dist directory.
  for (const file of first.files) {
    if (!file.endsWith(".map")) continue;
    let map;
    try {
      map = JSON.parse(readFileSync(join(first.root, file), "utf8"));
    } catch (error) {
      fail(`Source map ${file} is not valid JSON: ${error.message}`);
      continue;
    }
    const sources = Array.isArray(map.sources) ? map.sources : [];
    if (sources.length === 0) {
      fail(`Source map ${file} has no sources entries`);
    }
    if (
      !Array.isArray(map.sourcesContent) ||
      map.sourcesContent.length !== sources.length
    ) {
      fail(`Source map ${file} does not embed sourcesContent for every source`);
    }
    for (const source of sources) {
      if (typeof source !== "string") {
        fail(`Source map ${file} has a non-string sources entry`);
        continue;
      }
      if (
        source.startsWith("/") ||
        /^[a-zA-Z]:[\\/]/.test(source) ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source)
      ) {
        fail(`Source map ${file} has an absolute sources entry: ${source}`);
        continue;
      }
      const resolved = join(file, "..", source).split(sep).join("/");
      if (source.split("/").includes("..") || !resolved.startsWith("dist/")) {
        fail(
          `Source map ${file} escapes dist/ via sources entry: ${source} -> ${resolved}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("verify-pack: FAILED");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `verify-pack: OK (${first.files.length} files, reproducible across two packs)`,
    );
  }
} catch (error) {
  console.error(`verify-pack: FAILED\n  - ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
