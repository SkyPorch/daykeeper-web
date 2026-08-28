import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaykeeperWebClient,
  DaykeeperWebApiError,
  DaykeeperWebTransportError,
} from "../src/index.ts";

test("fetches a fresh customer token and preserves a gateway path", async () => {
  const requests: Request[] = [];
  let tokenCalls = 0;
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com/support-api/",
    getAccessToken: async () => `customer-token-${++tokenCalls}`,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ conversations: [], widgetConversationId: null });
    },
  });

  await client.listConversations();
  await client.listConversations();

  assert.equal(
    requests[0]?.url,
    "https://support.example.com/support-api/v1/conversations",
  );
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer customer-token-1",
  );
  assert.equal(
    requests[1]?.headers.get("authorization"),
    "Bearer customer-token-2",
  );
});

test("exposes stable gateway errors without including the token", async () => {
  const refreshRequests: boolean[] = [];
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com",
    getAccessToken: ({ forceRefresh }) => {
      refreshRequests.push(forceRefresh);
      return "do-not-leak";
    },
    fetch: async () =>
      Response.json({ error: "expired_token" }, { status: 401 }),
  });

  await assert.rejects(client.getUnread(), (error) => {
    assert(error instanceof DaykeeperWebApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "expired_token");
    assert(!JSON.stringify(error).includes("do-not-leak"));
    return true;
  });
  assert.deepEqual(refreshRequests, [false, true]);
});

test("refreshes once after a stale token is rejected", async () => {
  const refreshRequests: boolean[] = [];
  const authorization: Array<string | null> = [];
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com/support-api",
    getAccessToken: ({ forceRefresh }) => {
      refreshRequests.push(forceRefresh);
      return forceRefresh ? "fresh-token" : "stale-token";
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      authorization.push(request.headers.get("authorization"));
      if (authorization.length === 1) {
        return Response.json({ error: "expired_token" }, { status: 401 });
      }
      return Response.json({ unreadCount: 2 });
    },
  });

  assert.deepEqual(await client.getUnread(), { unreadCount: 2 });
  assert.deepEqual(refreshRequests, [false, true]);
  assert.deepEqual(authorization, ["Bearer stale-token", "Bearer fresh-token"]);
});

test("sends trimmed messages and validates conversation ids", async () => {
  let request: Request | undefined;
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com",
    getAccessToken: () => "token",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ message: {} }, { status: 201 });
    },
  });

  await client.sendMessage(42, "  hello  ");
  assert.equal(
    request?.url,
    "https://support.example.com/v1/conversations/42/messages",
  );
  assert.deepEqual(await request?.json(), { content: "hello" });
  assert.throws(
    () => client.sendMessage(0, "hello"),
    (error) =>
      error instanceof DaykeeperWebTransportError &&
      error.code === "INVALID_CONFIGURATION",
  );
});

test("encodes polling cursors as positive integers", async () => {
  let url = "";
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com",
    getAccessToken: () => "token",
    fetch: async (input) => {
      url = String(input);
      return Response.json({ messages: [] });
    },
  });

  await client.listMessages(7, { after: 11 });
  assert.equal(
    url,
    "https://support.example.com/v1/conversations/7/messages?after=11",
  );
});

test("claims a widget thread without placing its token in the URL", async () => {
  let request: Request | undefined;
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com",
    getAccessToken: () => "token",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ status: "merged", conversations: 1 });
    },
  });

  await client.claimAnonymousConversation("widget-secret");
  assert.equal(
    request?.url,
    "https://support.example.com/v1/anonymous-conversations/claim",
  );
  assert.deepEqual(await request?.json(), { widgetToken: "widget-secret" });
});

test("rejects insecure remote origins and header injection", async () => {
  assert.throws(
    () =>
      createDaykeeperWebClient({
        baseUrl: "http://support.example.com",
        getAccessToken: () => "token",
        fetch,
      }),
    (error) =>
      error instanceof DaykeeperWebTransportError &&
      error.code === "INVALID_CONFIGURATION",
  );

  const client = createDaykeeperWebClient({
    baseUrl: "http://127.0.0.1:3002",
    getAccessToken: () => "token\r\ninjected: value",
    fetch: async () => Response.json({ unreadCount: 0 }),
  });
  await assert.rejects(client.getUnread(), (error) => {
    assert(error instanceof DaykeeperWebTransportError);
    assert.equal(error.code, "INVALID_CONFIGURATION");
    return true;
  });
});

test("stops reading oversized responses", async () => {
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com",
    getAccessToken: () => "token",
    fetch: async () => new Response(new Uint8Array(1024 * 1024 + 1)),
  });

  await assert.rejects(client.listConversations(), (error) => {
    assert(error instanceof DaykeeperWebTransportError);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    return true;
  });
});
