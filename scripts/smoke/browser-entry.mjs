import {
  createDaykeeperWebClient,
  DaykeeperWebApiError,
  DaykeeperWebTransportError,
} from "@skyporch/daykeeper-web";

const checks = [];
function check(condition, name) {
  if (!condition) throw new Error(name);
  checks.push(name);
}
async function rejectsCode(request, expected) {
  try {
    await request;
    throw new Error(`Expected ${expected}`);
  } catch (error) {
    check(
      error instanceof DaykeeperWebTransportError && error.code === expected,
      expected,
    );
    return error;
  }
}
const origin = globalThis.DAYKEEPER_FIXTURE_GATEWAY;
const client = (path, options = {}) =>
  createDaykeeperWebClient({
    baseUrl: `${origin}/${path}`,
    getAccessToken: () => "synthetic-customer-token",
    ...options,
  });

async function main() {
  await fetch("/seed-cookie", { credentials: "include" });
  const ordinary = await client("allow").getUnread();
  check(ordinary.unreadCount === 0, "cross-origin customer GET");
  const cookies = await (
    await fetch("/cookies", { credentials: "include" })
  ).json();
  check(
    cookies.cookie.includes("daykeeper_fixture_cookie=seed"),
    "fixture cookie was genuinely set",
  );
  check(
    !cookies.cookie.includes("daykeeper_ignored"),
    "SDK response Set-Cookie was not persisted",
  );

  const refreshed = [];
  const signals = [];
  await client("refresh", {
    getAccessToken: ({ forceRefresh, signal }) => {
      refreshed.push(forceRefresh);
      signals.push(signal);
      return forceRefresh ? "synthetic-fresh-token" : "synthetic-stale-token";
    },
  }).getUnread();
  check(
    JSON.stringify(refreshed) === "[false,true]",
    "CORS-readable 401 refreshes exactly once",
  );
  check(signals[0] === signals[1], "refresh retains the original abort signal");

  let deniedRefreshCalls = 0;
  try {
    await client("no-refresh", {
      getAccessToken: () => {
        deniedRefreshCalls++;
        return "synthetic-customer-token";
      },
    }).getUnread();
    throw new Error("Expected an explicit non-retryable 401");
  } catch (error) {
    check(
      error instanceof DaykeeperWebApiError &&
        error.status === 401 &&
        !error.retryable,
      "CORS-readable explicit 401 denial stays non-retryable",
    );
    check(
      deniedRefreshCalls === 1,
      "explicit 401 denial never refreshes credentials",
    );
  }

  let maskedCalls = 0;
  await rejectsCode(
    client("masked401", {
      getAccessToken: () => {
        maskedCalls++;
        return "synthetic-customer-token";
      },
    }).getUnread(),
    "NETWORK_ERROR",
  );
  check(maskedCalls === 1, "CORS-masked 401 cannot trigger auth refresh");
  await rejectsCode(client("denied").getUnread(), "NETWORK_ERROR");
  await rejectsCode(client("redirect").getUnread(), "NETWORK_ERROR");

  try {
    await client("write-fail").createConversation();
    throw new Error("Expected a write failure");
  } catch (error) {
    check(
      error instanceof DaykeeperWebApiError &&
        error.status === 500 &&
        !error.retryable &&
        error.outcomeUnknown,
      "write failure exposes unknown outcome without replay",
    );
  }
  await rejectsCode(
    client("stall", { timeoutMs: 1000 }).getUnread(),
    "REQUEST_TIMEOUT",
  );
  await rejectsCode(client("oversized").getUnread(), "RESPONSE_TOO_LARGE");
  let providerCalls = 0;
  const controller = new AbortController();
  controller.abort("synthetic-private-abort-reason");
  const aborted = await rejectsCode(
    client("allow", {
      getAccessToken: () => {
        providerCalls++;
        return "synthetic-customer-token";
      },
    }).getUnread({ signal: controller.signal }),
    "REQUEST_ABORTED",
  );
  check(
    providerCalls === 0,
    "pre-aborted browser request never obtains a token",
  );
  check(
    !JSON.stringify(aborted).includes("synthetic-private"),
    "abort reason is redacted",
  );
  return { ok: true, checks };
}

async function report(result) {
  document.getElementById("result").textContent = JSON.stringify(result);
  // The local runner waits for actual completion, not Chromium virtual time.
  await fetch("/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}
main().then(report, (error) =>
  report({
    ok: false,
    checks,
    error: String(error.message),
  }),
);
