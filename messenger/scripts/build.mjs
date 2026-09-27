#!/usr/bin/env node
// Bundle the messenger into one self-contained IIFE: dist/messenger.js.
// No runtime dependencies are fetched; the headless SDK is bundled from source.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(`${root}package.json`, "utf8"));

const banner = `/*! Daykeeper Messenger ${version} | (c) 2026 SkyPorch | MIT License | includes @skyporch/daykeeper-web (MIT) */`;

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/messenger.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  // Evergreen browsers from ~2021 (constructable stylesheets need Safari 16.4;
  // older engines take the <style> fallback).
  target: ["chrome92", "firefox90", "safari15"],
  minify: true,
  sourcemap: "linked",
  sourcesContent: false,
  legalComments: "none",
  banner: { js: banner },
  define: { __MESSENGER_VERSION__: JSON.stringify(version) },
  metafile: true,
  logLevel: "warning",
  charset: "utf8",
});

const inputs = Object.keys(result.metafile.inputs);
const external = inputs.filter(
  (file) => !file.startsWith("src/") && !file.startsWith("../src/"),
);
if (external.length) {
  console.error("Unexpected bundle inputs:", external);
  process.exit(1);
}
console.log(
  `Built dist/messenger.js (${version}) from ${inputs.length} modules`,
);
