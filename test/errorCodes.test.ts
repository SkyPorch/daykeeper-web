import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaykeeperWebClient,
  DaykeeperWebApiError,
  isDaykeeperApiErrorCode,
  DAYKEEPER_GENERIC_API_CODE,
} from "../src/index.ts";

/**
 * Every error code the Daykeeper support gateway can put in the customer-facing
 * `{ "error": ... }` envelope, enumerated from `apps/gateway/server.mjs`,
 * `apps/gateway/auth.mjs` and `apps/gateway/chatwoot-client.mjs` in
 * `SkyPorch/daykeeper`. Consuming apps switch on these, so the SDK must hand
 * every one of them through unchanged. The gateway's vocabulary is open: it
 * grows without an SDK release, which is why the SDK checks the shape of a code
 * rather than matching it against a list.
 */
const GATEWAY_ERROR_CODES = [
  // auth.mjs — SupportAuthError, 401 unless noted
  "missing_bearer_token",
  "invalid_bearer_token",
  "invalid_token",
  "invalid_tenant",
  "unsupported_token",
  "invalid_signature",
  "invalid_issuer",
  "invalid_audience",
  "invalid_subject",
  "invalid_expiration",
  "expired_token",
  "token_lifetime_too_long",
  // server.mjs
  "unknown_tenant",
  "insufficient_scope",
  "erasure_targets_do_not_match_token",
  "unknown_campaign",
  "widget_token_required",
  "not_found",
  "support_upstream_rejected",
  "support_upstream_unavailable",
  // Codes the customer app still switches on from the pre-gateway support
  // stack and from services in front of the gateway. They are not emitted by
  // the three gateway modules today, but the contract calls codes extensible
  // and the SDK must not decide which ones are real.
  "support_gateway_request_failed",
  "conversation_not_found",
  "daykeeper_usage_limit_exceeded",
  "daykeeper_usage_not_enabled",
  "daykeeper_support_not_ready",
  "daykeeper_resource_conflict",
  "daykeeper_support_unavailable",
  "rate_limited",
];

function client(body: unknown, status: number) {
  return createDaykeeperWebClient({
    baseUrl: "https://support.example.test",
    getAccessToken: () => "synthetic-token",
    fetch: async () => Response.json(body, { status }),
  });
}

test("every enumerated gateway code has the documented shape", () => {
  for (const code of GATEWAY_ERROR_CODES) {
    assert.ok(isDaykeeperApiErrorCode(code), code);
  }
  assert.equal(new Set(GATEWAY_ERROR_CODES).size, GATEWAY_ERROR_CODES.length);
});

for (const code of GATEWAY_ERROR_CODES) {
  test(`gateway error code ${code} survives unchanged`, async () => {
    await assert.rejects(client({ error: code }, 403).getUnread(), (error) => {
      assert.ok(error instanceof DaykeeperWebApiError);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(JSON.parse(JSON.stringify(error)).code, code);
      return true;
    });
  });
}

test("a code the SDK has never seen is still handed to the caller", async () => {
  // The gateway can ship a new code before the SDK does; that must not become
  // a silent contract break in the consuming app's switch statement.
  for (const code of [
    "support_brand_new_condition",
    "invalid_future_claim",
    "a".repeat(64),
    "ab0",
  ]) {
    await assert.rejects(client({ error: code }, 400).getUnread(), (error) => {
      assert.ok(error instanceof DaykeeperWebApiError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test("free-form gateway messages collapse instead of leaking prose", async () => {
  // server.mjs answers some 4xx failures with `error: <Error.message>` rather
  // than a code. Those are English sentences and never reach the caller.
  for (const prose of [
    "Payload too large",
    "Invalid JSON",
    "At least one erasure target is required",
    "At most 100 erasure targets are allowed",
    "Each erasure target needs a userId or email",
    "Message content is required",
    "Conversation not found",
  ]) {
    await assert.rejects(client({ error: prose }, 400).getUnread(), (error) => {
      assert.ok(error instanceof DaykeeperWebApiError);
      assert.equal(error.code, DAYKEEPER_GENERIC_API_CODE);
      assert.equal(error.message, DAYKEEPER_GENERIC_API_CODE);
      assert.ok(!JSON.stringify(error).includes(prose.split(" ")[1] ?? ""));
      return true;
    });
  }
});

test("shapes that are not codes never reach the caller", () => {
  for (const value of [
    "Customer Name: private",
    "synthetic-customer-token",
    "a".repeat(65),
    "Ab",
    "ab",
    "_ab",
    "0ab",
    "ab ",
    { code: "not_a_string" },
    null,
    undefined,
    42,
  ]) {
    assert.equal(isDaykeeperApiErrorCode(value), false, String(value));
  }
});

test("the contract message field never becomes the error message", async () => {
  await assert.rejects(
    client(
      {
        error: "daykeeper_usage_limit_exceeded",
        message: "You have used your included conversations for August.",
        retryable: false,
        nextAction: "review_usage",
      },
      429,
    ).getUnread(),
    (error) => {
      assert.ok(error instanceof DaykeeperWebApiError);
      assert.equal(error.code, "daykeeper_usage_limit_exceeded");
      assert.equal(error.message, "daykeeper_usage_limit_exceeded");
      assert.equal(error.retryable, false);
      assert.equal(error.nextAction, "review_usage");
      assert.ok(!JSON.stringify(error).includes("August"));
      return true;
    },
  );
});

test("a 429 without retry advice keeps status-based retryability", async () => {
  await assert.rejects(
    client({ error: "rate_limited" }, 429).getUnread(),
    (error) => {
      assert.ok(error instanceof DaykeeperWebApiError);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
