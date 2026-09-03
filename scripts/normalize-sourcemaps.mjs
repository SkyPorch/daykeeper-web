#!/usr/bin/env node
// tsup emits source maps whose `sources` point at `../src/*.ts`. Only `dist`
// is published, so those paths resolve to files a consumer does not have: a
// debugger would try to load `node_modules/@skyporch/daykeeper-web/src/...`
// and fail. The original text is already embedded in `sourcesContent`, so the
// path is only a display label. Rewrite each label to a dist-local name and
// require the embedded content to be present, which keeps the map usable and
// stops it from referring outside the published tree.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

let changed = 0;
for (const name of readdirSync(dist)) {
  if (!name.endsWith(".map")) continue;
  const file = join(dist, name);
  const map = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(map.sources) || map.sources.length === 0) {
    console.error(`normalize-sourcemaps: ${name} has no sources`);
    process.exit(1);
  }
  if (
    !Array.isArray(map.sourcesContent) ||
    map.sourcesContent.length !== map.sources.length ||
    map.sourcesContent.some((entry) => typeof entry !== "string")
  ) {
    console.error(
      `normalize-sourcemaps: ${name} does not embed sourcesContent; refusing to rewrite its paths`,
    );
    process.exit(1);
  }
  map.sources = map.sources.map((source) => `./${basename(source)}`);
  delete map.sourceRoot;
  writeFileSync(file, `${JSON.stringify(map)}\n`);
  changed += 1;
}

console.log(`normalize-sourcemaps: rewrote ${changed} source map(s)`);
