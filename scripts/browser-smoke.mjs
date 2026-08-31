import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import { run } from "./run.mjs";

async function installedBrowser() {
  const candidates = process.env.DAYKEEPER_WEB_BROWSER_EXECUTABLE
    ? [process.env.DAYKEEPER_WEB_BROWSER_EXECUTABLE]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next installed binary only. */
    }
  }
  throw new Error(
    "No installed Chromium engine found. No browser download is performed; browser certification remains blocked.",
  );
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const unread = { unreadCount: 0, conversation: null, conversations: [] };
function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

export async function browserSmoke({ consumer, directory }) {
  const executable = await installedBrowser();
  const engine = (
    await run(executable, ["--version"], { timeout: 15_000 })
  ).stdout.trim();
  console.log(
    `Actual browser fixture check: ${engine}; fresh profile, loopback only`,
  );
  const profile = join(directory, "chromium-profile");
  await mkdir(profile, { mode: 0o700 });
  const bundleFile = join(directory, "browser-fixture.js");
  const buildResult = await build({
    absWorkingDir: consumer,
    entryPoints: ["browser-entry.mjs"],
    outfile: bundleFile,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    metafile: true,
    logLevel: "silent",
  });
  assert(
    Object.keys(buildResult.metafile.inputs).some((file) =>
      file.includes("node_modules/@skyporch/daykeeper-web/dist/index.js"),
    ),
  );
  const bundle = await readFile(bundleFile);
  const requests = [];
  let redirectTargetRequests = 0;
  let pageOrigin;
  let gatewayOrigin;
  let completeResult;
  let failResult;
  const completion = new Promise((resolve, reject) => {
    completeResult = resolve;
    failResult = reject;
  });
  // Register a handler before the server/child can report an early failure.
  completion.catch(() => {});
  let chromium;
  let browserClosed;
  let deadline;
  let browserStderr = "";
  const target = createServer((_request, response) => {
    redirectTargetRequests++;
    json(response, 200, unread);
  });
  const targetOrigin = await listen(target);
  const gateway = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    const mode = path.split("/")[1];
    const origin = request.headers.origin;
    requests.push({
      mode,
      method: request.method,
      cookie: request.headers.cookie ?? null,
      referrer: request.headers.referer ?? null,
      authorization: request.headers.authorization ?? null,
    });
    const allowed = origin === pageOrigin && mode !== "denied";
    const cors = allowed
      ? { "access-control-allow-origin": pageOrigin, vary: "Origin" }
      : {};
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...cors,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      response.end();
      return;
    }
    if (mode === "masked401")
      return json(response, 401, { error: "expired_token" });
    if (
      mode === "refresh" &&
      request.headers.authorization === "Bearer synthetic-stale-token"
    )
      return json(response, 401, { error: "expired_token" }, cors);
    if (mode === "redirect") {
      response.writeHead(302, {
        ...cors,
        location: `${targetOrigin}/must-not-receive-token`,
      });
      response.end();
      return;
    }
    if (mode === "write-fail")
      return json(
        response,
        500,
        { error: "support_upstream_unavailable" },
        cors,
      );
    if (mode === "stall" || mode === "oversized") {
      response.writeHead(200, {
        ...cors,
        "content-type": "application/json",
        ...(mode === "oversized"
          ? { "content-length": String(1024 * 1024 + 1) }
          : {}),
      });
      response.write("{");
      return;
    }
    return json(response, 200, unread, {
      ...cors,
      "set-cookie": "daykeeper_ignored=do-not-store; Path=/; SameSite=Lax",
    });
  });
  const page = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    if (path === "/result") {
      if (request.method !== "POST" || request.headers.origin !== pageOrigin) {
        response.writeHead(403).end();
        return;
      }
      void (async () => {
        try {
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString("utf8");
            assert(
              Buffer.byteLength(body) <= 8192,
              "Fixture result exceeds bound",
            );
          }
          const result = JSON.parse(body);
          assert(
            typeof result.ok === "boolean" && Array.isArray(result.checks),
          );
          assert(result.checks.every((check) => typeof check === "string"));
          json(response, 200, { received: true });
          completeResult(result);
        } catch (error) {
          response.writeHead(400).end();
          failResult(error);
        }
      })();
      return;
    }
    if (path === "/seed-cookie")
      return json(
        response,
        200,
        { ok: true },
        {
          "set-cookie":
            "daykeeper_fixture_cookie=seed; Path=/; HttpOnly; SameSite=Lax",
        },
      );
    if (path === "/cookies")
      return json(response, 200, { cookie: request.headers.cookie ?? "" });
    if (path === "/bundle.js") {
      response.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      response.end(bundle);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Daykeeper SDK fixture</title><pre id="result">running</pre><script>globalThis.DAYKEEPER_FIXTURE_GATEWAY=${JSON.stringify(gatewayOrigin)}</script><script src="/bundle.js"></script>`,
    );
  });
  try {
    gatewayOrigin = await listen(gateway);
    pageOrigin = await listen(page);
    chromium = spawn(
      executable,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-breakpad",
        "--no-pings",
        "--use-mock-keychain",
        "--password-store=basic",
        "--metrics-recording-only",
        `${pageOrigin}/?synthetic-referrer-marker=do-not-forward`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    chromium.stderr.on("data", (chunk) => {
      browserStderr = (browserStderr + chunk.toString()).slice(-64 * 1024);
    });
    chromium.once("error", failResult);
    browserClosed = new Promise((resolve) =>
      chromium.once("close", (code) => {
        failResult(
          new Error(`Browser exited before fixture completion (${code})`),
        );
        resolve();
      }),
    );
    deadline = setTimeout(
      () =>
        failResult(
          new Error("Browser fixture did not complete within 45 seconds"),
        ),
      45_000,
    );
    const actual = await completion;
    clearTimeout(deadline);
    assert.equal(actual.ok, true, JSON.stringify(actual));
    const api = requests.filter((request) => request.method !== "OPTIONS");
    assert(
      api.length >= 8,
      "Browser did not make the expected customer API fixture requests",
    );
    assert(
      api.every((request) => request.cookie === null),
      "SDK request forwarded a cookie",
    );
    assert(
      api.every((request) => request.referrer === null),
      "SDK request forwarded a referrer",
    );
    assert.equal(
      redirectTargetRequests,
      0,
      "Redirect target received a request",
    );
    assert.equal(
      api.filter((request) => request.mode === "write-fail").length,
      1,
      "A write was replayed",
    );
    assert.equal(api.filter((request) => request.mode === "refresh").length, 2);
    assert.equal(
      api.filter((request) => request.mode === "masked401").length,
      1,
    );
    assert.equal(api.filter((request) => request.mode === "denied").length, 0);
    const evidence = {
      engine,
      kind: "actual Chromium, synthetic loopback fixtures only",
      checks: [
        ...actual.checks,
        "all customer requests omitted cookies",
        "all customer requests omitted referrers",
        "redirect target received zero requests",
        "failed write received exactly one request",
        "denied preflight prevented API dispatch",
      ],
      requestCount: api.length,
      redirectTargetRequests,
    };
    await writeFile(
      join(directory, "browser-result.json"),
      JSON.stringify(evidence, null, 2),
    );
    return evidence;
  } finally {
    clearTimeout(deadline);
    if (chromium) {
      chromium.kill("SIGTERM");
      const forceStop = setTimeout(() => chromium.kill("SIGKILL"), 3000);
      await browserClosed;
      clearTimeout(forceStop);
      await writeFile(join(directory, "browser-stderr.log"), browserStderr);
    }
    for (const server of [page, gateway, target]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
