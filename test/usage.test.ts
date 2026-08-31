import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaykeeperWebClient,
  DaykeeperWebApiError,
} from "../src/index.ts";

const contracts = [
  [429, "daykeeper_usage_limit_exceeded"],
  [403, "daykeeper_usage_not_enabled"],
  [403, "daykeeper_support_not_ready"],
  [409, "daykeeper_resource_conflict"],
  [503, "daykeeper_support_unavailable"],
] as const;

test("an explicit 401 retry denial is honored before token refresh or replay", async () => {
  for (const hint of [false, true, undefined, "false"]) {
    for (const mutation of [false, true]) {
      const refreshed: boolean[] = [];
      let calls = 0;
      const client = createDaykeeperWebClient({
        baseUrl: "https://support.example.test",
        getAccessToken: ({ forceRefresh }) => {
          refreshed.push(forceRefresh);
          return "synthetic-token";
        },
        fetch: async () =>
          ++calls === 1
            ? Response.json(
                {
                  error: "expired_token",
                  retryable: hint,
                  message: "private-denial",
                },
                { status: 401 },
              )
            : Response.json({
                unreadCount: 0,
                conversation: null,
                conversations: [],
              }),
      });
      if (hint === false || mutation) {
        await assert.rejects(
          mutation ? client.createConversation() : client.getUnread(),
          (error) => {
            assert(error instanceof DaykeeperWebApiError);
            assert.equal(error.status, 401);
            assert.equal(error.retryable, false);
            assert.doesNotMatch(JSON.stringify(error), /private-denial/);
            return true;
          },
        );
        assert.equal(calls, 1);
        assert.deepEqual(refreshed, [false]);
      } else {
        await client.getUnread();
        assert.equal(calls, 2);
        assert.deepEqual(refreshed, [false, true]);
      }
    }
  }
});

test("known usage failures keep safe codes and explicit non-retry advice without leaking provider text", async () => {
  for (const [status, code] of contracts) {
    for (const mutation of [false, true]) {
      let calls = 0;
      const client = createDaykeeperWebClient({
        baseUrl: "https://support.example.test",
        getAccessToken: () => "synthetic-customer",
        fetch: async () => {
          calls++;
          return Response.json(
            {
              error: code,
              retryable: false,
              message: "synthetic-private-content",
              nextAction: "synthetic-private-token",
              diagnostic: { sql: "synthetic-private-data" },
            },
            { status },
          );
        },
      });
      await assert.rejects(
        mutation ? client.createConversation() : client.getUnread(),
        (error) => {
          assert(error instanceof DaykeeperWebApiError);
          assert.equal(error.status, status);
          assert.equal(error.code, code);
          assert.equal(error.retryable, false);
          // A server failure after a dispatched write remains uncertain even if
          // the server supplied a familiar code. Never automatically replay it.
          assert.equal(error.outcomeUnknown, mutation && status >= 500);
          assert(!JSON.stringify(error).includes("synthetic-private"));
          assert(!String(error.stack).includes("synthetic-private"));
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  }
});

test("only boolean retry hints override legacy read inference; no hint authorizes mutation replay", async () => {
  for (const [hint, expected] of [
    [false, false],
    [true, true],
    [undefined, true],
    ["false", true],
    [null, true],
    [0, true],
  ] as const) {
    for (const mutation of [false, true]) {
      let calls = 0;
      const client = createDaykeeperWebClient({
        baseUrl: "https://support.example.test",
        getAccessToken: () => "synthetic-customer",
        fetch: async () => {
          calls++;
          return Response.json(
            { error: "support_upstream_unavailable", retryable: hint },
            { status: 503 },
          );
        },
      });
      await assert.rejects(
        mutation ? client.createConversation() : client.getUnread(),
        (error) => {
          assert(error instanceof DaykeeperWebApiError);
          assert.equal(error.retryable, mutation ? false : expected);
          assert.equal(error.outcomeUnknown, mutation);
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  }
});
