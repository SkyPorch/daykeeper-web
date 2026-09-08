import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { run, toolEnvironment } from "./run.mjs";
import { browserSmoke } from "./browser-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const browser = process.argv.includes("--browser");
assert(
  process.argv.slice(2).every((arg) => arg === "--browser"),
  "Unknown smoke option",
);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await mkdir(join(root, ".smoke"), { recursive: true });
const directory = await mkdtemp(join(root, ".smoke/package-"));
const consumer = join(directory, "consumer");
await mkdir(consumer);
const env = toolEnvironment(join(directory, "npm-cache"));
console.log("Packing the built SDK and installing an offline npm consumer...");
const packed = await run(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
  { cwd: root, env },
);
const [pack] = JSON.parse(packed.stdout);
assert.equal(pack.name, "@skyporch/daykeeper-web");
assert.equal(pack.version, manifest.version);
const allowed = new Set([
  "package.json",
  "LICENSE",
  "NOTICE",
  "README.md",
  "CHANGELOG.md",
  "COMPATIBILITY.md",
  "CONTRIBUTING.md",
  "RELEASING.md",
  "SECURITY.md",
  "openapi/SOURCE.md",
  "openapi/customer.yaml",
  "openapi/LICENSE",
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
  "dist/index.js.map",
  "dist/index.cjs.map",
]);
assert.deepEqual(
  new Set(pack.files.map((file) => file.path)),
  allowed,
  "Unexpected or missing tarball contents",
);
const tarball = join(directory, pack.filename);
const hash = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "daykeeper-sdk-consumer-smoke",
      version: "0.0.0",
      private: true,
      type: "module",
    },
    null,
    2,
  ),
);
await run(
  "npm",
  [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    tarball,
  ],
  { cwd: consumer, env },
);
const installedRoot = join(consumer, "node_modules/@skyporch/daykeeper-web");
const installed = JSON.parse(
  await readFile(join(installedRoot, "package.json"), "utf8"),
);
assert.equal(installed.name, manifest.name);
assert.equal(installed.private, false);
assert.equal(installed.license, "MIT");
assert.deepEqual(installed.dependencies ?? {}, {});
for (const name of [
  "consumer.mjs",
  "consumer.mts",
  "consumer.cts",
  "browser-entry.mjs",
]) {
  await copyFile(join(root, "scripts/smoke", name), join(consumer, name));
}
for (const file of pack.files) {
  const content = await readFile(join(installedRoot, file.path), "utf8");
  assert(
    !content.includes(root),
    "A local build path escaped into the tarball",
  );
}
const esm = await import(pathToFileURL(join(consumer, "consumer.mjs")).href);
const cjs = createRequire(join(consumer, "package.json"))(manifest.name);
for (const entry of [esm, cjs])
  assert.equal(typeof entry.createDaykeeperWebClient, "function");
await run(
  join(root, "node_modules/.bin/tsc"),
  [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--lib",
    "ES2022,DOM,DOM.Iterable",
    "consumer.mts",
    "consumer.cts",
  ],
  { cwd: consumer, env },
);
const bundled = await build({
  absWorkingDir: consumer,
  entryPoints: ["consumer.mjs"],
  outfile: join(directory, "consumer.browser.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "DaykeeperSmokeSDK",
  target: "es2020",
  metafile: true,
  write: false,
  logLevel: "silent",
});
assert(
  Object.keys(bundled.metafile.inputs).some((path) =>
    path.includes("node_modules/@skyporch/daykeeper-web/dist/index.js"),
  ),
  "The bundle must consume the installed tarball export",
);
assert.equal(
  Object.values(bundled.metafile.outputs).flatMap((output) => output.imports)
    .length,
  0,
  "Browser bundle must have no external imports",
);
const code = bundled.outputFiles[0].text;
assert(!/\b(?:process|Buffer)\b|node:|\brequire\s*\(/.test(code));
await writeFile(join(directory, "consumer.browser.js"), code);
await writeFile(
  join(directory, "bundle-metafile.json"),
  JSON.stringify(bundled.metafile, null, 2),
);
const context = vm.createContext({
  fetch,
  Headers,
  Request,
  URL,
  AbortController,
  TextDecoder,
  setTimeout,
  clearTimeout,
  performance,
});
vm.runInContext(code, context, { timeout: 1000 });
assert.equal(vm.runInContext("typeof process", context), "undefined");
assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
assert.equal(vm.runInContext("typeof document", context), "undefined");

let requests = 0;
let usageFailure;
const server = createServer((request, response) => {
  requests++;
  assert.equal(
    request.url,
    request.method === "POST"
      ? "/support-api/v1/conversations"
      : "/support-api/v1/unread",
  );
  assert.equal(
    request.headers.authorization,
    "Bearer synthetic-customer-token",
  );
  if (usageFailure) {
    response.writeHead(usageFailure[0], { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: usageFailure[1],
        retryable: false,
        message: "synthetic-private-diagnostic",
        nextAction: "https://private.example.test/token",
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ unreadCount: 0, conversation: null, conversations: [] }),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/support-api`;
  for (const entry of [esm, cjs, context.DaykeeperSmokeSDK]) {
    const client = entry.createDaykeeperWebClient({
      baseUrl,
      getAccessToken: () => "synthetic-customer-token",
    });
    const result = await client.getUnread();
    assert.equal(result.unreadCount, 0);
    assert.deepEqual(Array.from(result.conversations), []);
  }
  assert.equal(requests, 3);
  for (const entry of [esm, cjs, context.DaykeeperSmokeSDK]) {
    const client = entry.createDaykeeperWebClient({
      baseUrl,
      getAccessToken: () => "synthetic-customer-token",
    });
    for (const [status, code] of [
      [429, "daykeeper_usage_limit_exceeded"],
      [403, "daykeeper_usage_not_enabled"],
      [403, "daykeeper_support_not_ready"],
      [409, "daykeeper_resource_conflict"],
      [503, "daykeeper_support_unavailable"],
      [401, "expired_token"],
    ]) {
      usageFailure = [status, code];
      for (const mutation of [false, true]) {
        const before = requests;
        await assert.rejects(
          mutation ? client.createConversation() : client.getUnread(),
          (error) => {
            assert(error instanceof entry.DaykeeperWebApiError);
            assert.equal(error.code, code);
            assert.equal(error.status, status);
            assert.equal(error.retryable, false);
            assert.equal(error.outcomeUnknown, mutation && status >= 500);
            assert.doesNotMatch(JSON.stringify(error), /private/);
            assert.doesNotMatch(
              String(error.stack),
              /private-diagnostic|private\.example/,
            );
            return true;
          },
        );
        assert.equal(
          requests,
          before + 1,
          "Known usage errors never replay a request",
        );
      }
    }
  }
  assert.equal(requests, 39);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

const result = {
  package: manifest.name,
  version: manifest.version,
  private: false,
  node: process.version,
  tarballSha256: hash,
  tarball,
  packedFiles: pack.files.map((file) => file.path),
  packedBytes: pack.size,
  unpackedBytes: pack.unpackedSize,
  checks: [
    "offline npm tarball consumer",
    "ESM import",
    "CommonJS require",
    "ESM and CJS TypeScript declaration resolution",
    "customer-only API type exclusions",
    "browser-target bundle from installed export",
    "bundle execution without Node/DOM globals",
    "39 real loopback HTTP requests across ESM, CJS and browser-target bundle",
    "five managed usage failures preserve safe advice, redact bodies and never replay",
  ],
  browser: browser ? await browserSmoke({ root, consumer, directory }) : null,
};
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(result, null, 2),
);
await writeFile(
  join(root, ".smoke/latest-package.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
