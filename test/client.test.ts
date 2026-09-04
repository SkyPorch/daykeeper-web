import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaykeeperWebClient,
  DaykeeperWebApiError,
  DaykeeperWebClient,
  DaykeeperWebTransportError,
  type DaykeeperWebClientOptions,
} from "../src/index.ts";

const baseUrl = "https://support.example.com/support-api";
const syntheticToken = "synthetic-customer-token";
const success = () => Response.json({ unreadCount: 0 });
const makeClient = (options: Partial<DaykeeperWebClientOptions> = {}) =>
  createDaykeeperWebClient({
    baseUrl,
    getAccessToken: () => syntheticToken,
    fetch: async () => success(),
    ...options,
  });

/**
 * The SDK hands its transport one hardened Request and no RequestInit. Inspect
 * that object directly: copying it through `new Request(...)` drops fields such
 * as `referrerPolicy` on some Fetch implementations, which would hide part of
 * the policy the SDK actually dispatched.
 */
const dispatchedRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Request =>
  input instanceof Request && init === undefined
    ? input
    : new Request(input as RequestInfo, init);

function isConfiguration(error: unknown): boolean {
  assert(error instanceof DaykeeperWebTransportError);
  assert.equal(error.code, "INVALID_CONFIGURATION");
  assert.equal(error.retryable, false);
  return true;
}

test("exposes exactly the eight customer methods and no service/admin escape hatch", () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(DaykeeperWebClient.prototype).sort(),
    [
      "constructor",
      "getIdentity",
      "listConversations",
      "createConversation",
      "getUnread",
      "markConversationSeen",
      "listMessages",
      "sendMessage",
      "claimAnonymousConversation",
    ].sort(),
  );
  assert.deepEqual(Object.keys(makeClient()), []);
});

test("every method has the contract URL, verb, payload and browser request policy", async () => {
  const requests: Request[] = [];
  let tokenCalls = 0;
  const client = makeClient({
    baseUrl: `${baseUrl}///`,
    getAccessToken: () => `${syntheticToken}-${++tokenCalls}`,
    fetch: async (input, init) => {
      requests.push(dispatchedRequest(input, init));
      return Response.json({ ok: true });
    },
  });
  await client.getIdentity();
  await client.listConversations();
  await client.createConversation();
  await client.getUnread();
  await client.markConversationSeen(42);
  await client.listMessages(42, { after: 7 });
  await client.sendMessage(42, "  Hello from a customer.  ");
  await client.claimAnonymousConversation("  synthetic-widget-token  ");
  const expected = [
    ["GET", "/v1/identity", null],
    ["GET", "/v1/conversations", null],
    ["POST", "/v1/conversations", null],
    ["GET", "/v1/unread", null],
    ["POST", "/v1/conversations/42/seen", null],
    ["GET", "/v1/conversations/42/messages?after=7", null],
    [
      "POST",
      "/v1/conversations/42/messages",
      { content: "Hello from a customer." },
    ],
    [
      "POST",
      "/v1/anonymous-conversations/claim",
      { widgetToken: "synthetic-widget-token" },
    ],
  ] as const;
  assert.equal(tokenCalls, expected.length);
  for (const [index, [method, path, body]] of expected.entries()) {
    const request = requests[index]!;
    assert.equal(request.url, `${baseUrl}${path}`);
    assert.equal(request.method, method);
    assert.equal(request.credentials, "omit");
    assert.equal(request.mode, "cors");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.equal(request.referrerPolicy, "no-referrer");
    assert.equal(
      request.headers.get("authorization"),
      `Bearer ${syntheticToken}-${index + 1}`,
    );
    assert.equal(request.headers.get("accept"), "application/json");
    assert.equal(request.headers.has("cookie"), false);
    assert.equal(request.headers.has("x-tenant-id"), false);
    assert.equal(request.headers.has("x-api-key"), false);
    if (body === null) {
      assert.equal(await request.text(), "");
      assert.equal(request.headers.has("content-type"), false);
    } else {
      assert.equal(request.headers.get("content-type"), "application/json");
      assert.deepEqual(await request.json(), body);
    }
    assert(!request.url.includes(syntheticToken));
    assert(!request.url.includes("synthetic-widget-token"));
  }
});

test("token providers are called per request without a shared identity/token cache", async () => {
  let activeToken = "customer-a";
  const sent: string[] = [];
  const client = makeClient({
    getAccessToken: () => activeToken,
    // The SDK dispatches a hardened Request, so read the header from it.
    fetch: async (input) => {
      sent.push(dispatchedRequest(input).headers.get("authorization")!);
      return success();
    },
  });
  await client.getUnread();
  activeToken = "customer-b";
  await client.getUnread();
  assert.deepEqual(sent, ["Bearer customer-a", "Bearer customer-b"]);
  assert(!JSON.stringify(client).includes(activeToken));
});

test("independent clients retain independent gateway and customer providers", async () => {
  const sent: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    sent.push(dispatchedRequest(input, init));
    return success();
  };
  await Promise.all([
    makeClient({
      baseUrl: "https://a.example.com",
      getAccessToken: () => "customer-a",
      fetch: fetchImpl,
    }).getUnread(),
    makeClient({
      baseUrl: "https://b.example.com",
      getAccessToken: () => "customer-b",
      fetch: fetchImpl,
    }).getUnread(),
  ]);
  assert.deepEqual(
    sent.map((request) => [request.url, request.headers.get("authorization")]),
    [
      ["https://a.example.com/v1/unread", "Bearer customer-a"],
      ["https://b.example.com/v1/unread", "Bearer customer-b"],
    ],
  );
});

test("GET refreshes once after 401 within the original signal and browser policy", async () => {
  const refresh: boolean[] = [];
  const signals: AbortSignal[] = [];
  const sent: Request[] = [];
  const client = makeClient({
    getAccessToken: (context) => {
      refresh.push(context.forceRefresh);
      signals.push(context.signal);
      return context.forceRefresh ? "fresh-token" : "stale-token";
    },
    fetch: async (input, init) => {
      sent.push(dispatchedRequest(input, init));
      return sent.length === 1
        ? Response.json({ error: "expired_token" }, { status: 401 })
        : success();
    },
  });
  await client.getUnread();
  assert.deepEqual(refresh, [false, true]);
  assert.equal(signals[0], signals[1]);
  assert.deepEqual(
    sent.map((request) => request.headers.get("authorization")),
    ["Bearer stale-token", "Bearer fresh-token"],
  );
  assert(
    sent.every(
      (request) =>
        request.credentials === "omit" && request.redirect === "error",
    ),
  );
});

test("a second 401 is returned as a redacted auth error without a third attempt", async () => {
  const refresh: boolean[] = [];
  let calls = 0;
  const client = makeClient({
    getAccessToken: ({ forceRefresh }) => {
      refresh.push(forceRefresh);
      return syntheticToken;
    },
    fetch: async () => {
      calls++;
      return Response.json(
        { error: "expired_token", debug: syntheticToken },
        { status: 401 },
      );
    },
  });
  await assert.rejects(client.getUnread(), (error) => {
    assert(error instanceof DaykeeperWebApiError);
    assert.deepEqual(error.toJSON(), {
      name: "DaykeeperWebApiError",
      status: 401,
      code: "expired_token",
      retryable: false,
      outcomeUnknown: false,
    });
    assert(!String(error.stack).includes(syntheticToken));
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(refresh, [false, true]);
});

for (const status of [403, 404, 429, 502]) {
  test(`GET ${status} does not refresh, switch tenant, or automatically replay`, async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const client = makeClient({
      getAccessToken: ({ forceRefresh }) => {
        tokenCalls++;
        assert.equal(forceRefresh, false);
        return "customer-a";
      },
      fetch: async () => {
        fetchCalls++;
        return Response.json(
          { error: "foreign-tenant-private-customer-details" },
          { status },
        );
      },
    });
    await assert.rejects(client.listMessages(42), (error) => {
      assert(error instanceof DaykeeperWebApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, "daykeeper_request_failed");
      assert(!JSON.stringify(error).includes("foreign-tenant"));
      return true;
    });
    assert.equal(tokenCalls, 1);
    assert.equal(fetchCalls, 1);
  });
}

const writes = {
  create: (client: DaykeeperWebClient) => client.createConversation(),
  send: (client: DaykeeperWebClient) =>
    client.sendMessage(42, "Synthetic message"),
  seen: (client: DaykeeperWebClient) => client.markConversationSeen(42),
  claim: (client: DaykeeperWebClient) =>
    client.claimAnonymousConversation("synthetic-widget-token"),
};
for (const [name, write] of Object.entries(writes)) {
  for (const status of [401, 408, 429, 500]) {
    test(`${name} is never automatically replayed after HTTP ${status}`, async () => {
      let tokenCalls = 0;
      let fetchCalls = 0;
      const client = makeClient({
        getAccessToken: ({ forceRefresh }) => {
          assert.equal(forceRefresh, false);
          tokenCalls++;
          return syntheticToken;
        },
        fetch: async () => {
          fetchCalls++;
          return Response.json({ error: "expired_token" }, { status });
        },
      });
      await assert.rejects(write(client), (error) => {
        assert(error instanceof DaykeeperWebApiError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, false);
        assert.equal(error.outcomeUnknown, status === 408 || status >= 500);
        return true;
      });
      assert.equal(tokenCalls, 1);
      assert.equal(fetchCalls, 1);
    });
  }
}

test("network failure after write dispatch has unknown outcome and no replay", async () => {
  let calls = 0;
  const client = makeClient({
    fetch: async () => {
      calls++;
      throw new Error(syntheticToken);
    },
  });
  await assert.rejects(client.sendMessage(42, "Synthetic message"), (error) => {
    assert(error instanceof DaykeeperWebTransportError);
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.retryable, false);
    assert.equal(error.outcomeUnknown, true);
    assert(!JSON.stringify(error).includes(syntheticToken));
    return true;
  });
  assert.equal(calls, 1);
});

test("pre-dispatch write cancellation does not imply a server mutation", async () => {
  const caller = new AbortController();
  caller.abort(syntheticToken);
  let calls = 0;
  const client = makeClient({
    getAccessToken: () => {
      calls++;
      return syntheticToken;
    },
  });
  await assert.rejects(
    client.createConversation({ signal: caller.signal }),
    (error) => {
      assert(error instanceof DaykeeperWebTransportError);
      assert.equal(error.code, "REQUEST_ABORTED");
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 0);
});

for (const dispatched of [false, true]) {
  test(`write deadline preserves whether transport was dispatched (${dispatched})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let fetchCalls = 0;
    const client = makeClient({
      timeoutMs: 1000,
      getAccessToken: () => {
        if (dispatched) return syntheticToken;
        ready!();
        return new Promise<string>(() => {});
      },
      fetch: async () => {
        fetchCalls++;
        ready!();
        return new Promise<Response>(() => {});
      },
    });
    const rejected = assert.rejects(client.createConversation(), (error) => {
      assert(error instanceof DaykeeperWebTransportError);
      assert.equal(error.code, "REQUEST_TIMEOUT");
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, dispatched);
      return true;
    });
    await started;
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(fetchCalls, dispatched ? 1 : 0);
  });
}

test("missing browser globals fail with a structured configuration error", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "AbortController",
  );
  try {
    Object.defineProperty(globalThis, "AbortController", {
      configurable: true,
      value: undefined,
    });
    assert.throws(() => makeClient(), isConfiguration);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "AbortController", descriptor);
  }
});

test("the SDK never reads browser storage or a document cookie", async () => {
  const names = ["localStorage", "sessionStorage", "indexedDB", "document"];
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  try {
    for (const name of names)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error("Storage must not be read");
        },
      });
    await makeClient().getUnread();
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

for (const origin of [
  "http://localhost:4000",
  "http://127.0.0.1:4000",
  "http://127.0.0.2:4000",
  "http://[::1]:4000",
  "https://support.example.com",
]) {
  test(`accepts secure or actual loopback base URL ${origin}`, () => {
    assert.doesNotThrow(() => makeClient({ baseUrl: origin }));
  });
}

for (const origin of [
  "http://support.example.com",
  "http://localhost.example.com",
  "http://localhost.",
  "http://127.0.0.1.example.com",
  "http://10.0.2.2",
  "http://192.168.1.1",
  "http://0.0.0.0",
  "file:///tmp/sdk",
  "data:text/plain,secret",
  "javascript:alert(1)",
  "https://user:secret@support.example.com",
  "https://support.example.com?",
  "https://support.example.com#",
  "https://support.example.com?token=secret",
  "https://support.example.com#secret",
  "",
]) {
  test(`rejects unsafe or ambiguous base URL ${origin}`, () => {
    assert.throws(() => makeClient({ baseUrl: origin }), isConfiguration);
  });
}

test("rejects invalid options, globals, timeout ranges, and provider/transport shapes", () => {
  assert.throws(
    () => new DaykeeperWebClient(null as unknown as DaykeeperWebClientOptions),
    isConfiguration,
  );
  assert.throws(
    () =>
      makeClient({
        getAccessToken:
          3 as unknown as DaykeeperWebClientOptions["getAccessToken"],
      }),
    isConfiguration,
  );
  assert.throws(
    () => makeClient({ fetch: false as unknown as typeof fetch }),
    isConfiguration,
  );
  for (const timeoutMs of [0, 999, 60_001, 1.2, NaN, Infinity])
    assert.throws(() => makeClient({ timeoutMs }), isConfiguration);
  assert.doesNotThrow(() => makeClient({ timeoutMs: 1000 }));
  assert.doesNotThrow(() => makeClient({ timeoutMs: 60_000 }));
});

test("rejects unsafe customer tokens before any network dispatch", async () => {
  for (const value of [
    "",
    " ",
    "token\r\nheader:value",
    "token\tvalue",
    "token value",
    "é",
    "x".repeat(16_385),
    1,
    null,
    {},
  ]) {
    let calls = 0;
    const client = makeClient({
      getAccessToken: () => value as string,
      fetch: async () => {
        calls++;
        return success();
      },
    });
    await assert.rejects(client.getUnread(), isConfiguration);
    assert.equal(calls, 0);
  }
});

test("validates safe ids, cursors, message lengths and widget token bounds", () => {
  const client = makeClient();
  for (const id of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => client.listMessages(id), isConfiguration);
    assert.throws(() => client.markConversationSeen(id), isConfiguration);
    assert.throws(
      () => client.sendMessage(id, "Synthetic message"),
      isConfiguration,
    );
    assert.throws(() => client.listMessages(1, { after: id }), isConfiguration);
  }
  for (const content of ["", "   ", "x".repeat(16_001), null])
    assert.throws(
      () => client.sendMessage(1, content as string),
      isConfiguration,
    );
  for (const value of ["", "   ", "x".repeat(16_385), null])
    assert.throws(
      () => client.claimAnonymousConversation(value as string),
      isConfiguration,
    );
});

for (const kind of [
  "redirect",
  "followed",
  "other-origin",
  "other-path",
  "opaque",
  "opaqueredirect",
]) {
  test(`rejects ${kind} response metadata without exposing URLs or response bodies`, async () => {
    const response = new Response("private-response-content", {
      status: kind === "redirect" ? 302 : 200,
    });
    if (kind === "followed")
      Object.defineProperty(response, "redirected", { value: true });
    if (kind === "other-origin")
      Object.defineProperty(response, "url", {
        value: "https://other.example.com/private-token",
      });
    if (kind === "other-path")
      Object.defineProperty(response, "url", {
        value: `${baseUrl}/private-token`,
      });
    if (kind.startsWith("opaque"))
      Object.defineProperty(response, "type", { value: kind });
    let calls = 0;
    const client = makeClient({
      fetch: async () => {
        calls++;
        return response;
      },
    });
    await assert.rejects(client.getUnread(), (error) => {
      assert(error instanceof DaykeeperWebTransportError);
      assert.equal(error.code, "REDIRECT_REJECTED");
      assert.equal(error.retryable, false);
      assert(!JSON.stringify(error).includes("private"));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("untrusted API error strings and nested metadata never escape", async () => {
  for (const code of [
    syntheticToken,
    "a".repeat(100),
    "Customer Name: private",
    { token: syntheticToken },
    null,
  ]) {
    const client = makeClient({
      fetch: async () =>
        Response.json(
          { error: code, token: syntheticToken, message: syntheticToken },
          { status: 403 },
        ),
    });
    await assert.rejects(client.getUnread(), (error) => {
      assert(error instanceof DaykeeperWebApiError);
      assert.equal(error.code, "daykeeper_request_failed");
      assert(!JSON.stringify(error).includes(syntheticToken));
      assert(!String(error.stack).includes(syntheticToken));
      assert.equal(error.cause, undefined);
      assert.equal("response" in error, false);
      return true;
    });
  }
});

for (const payload of [
  "private malformed json",
  "[]",
  "null",
  '"private scalar"',
  "",
]) {
  test(`rejects non-object/invalid success payload ${payload}`, async () => {
    const client = makeClient({ fetch: async () => new Response(payload) });
    await assert.rejects(client.getUnread(), (error) => {
      assert(error instanceof DaykeeperWebTransportError);
      assert.equal(error.code, "INVALID_RESPONSE");
      assert(!JSON.stringify(error).includes("private"));
      return true;
    });
  });
}

test("bounds streamed UTF-8 response bytes even when content-length lies", async () => {
  const bytes = new TextEncoder().encode(
    `{"message":"${"é".repeat(600_000)}"}`,
  );
  const client = makeClient({
    fetch: async () =>
      new Response(bytes, { headers: { "content-length": "10" } }),
  });
  await assert.rejects(client.getUnread(), (error) => {
    assert(error instanceof DaykeeperWebTransportError);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    return true;
  });
});

test("buffered custom Fetch responses are also capped in UTF-8 bytes", async () => {
  const client = makeClient({
    fetch: async () =>
      ({
        body: null,
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => `{"message":"${"é".repeat(600_000)}"}`,
      }) as Response,
  });
  await assert.rejects(client.getUnread(), (error) => {
    assert(error instanceof DaykeeperWebTransportError);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    return true;
  });
});

test("an injected Fetch receives the browser transport policy on the Request itself", async () => {
  const dispatched: Request[] = [];
  const client = makeClient({
    // A transport that ignores RequestInit entirely still cannot relax the
    // policy: it is baked into the Request the SDK hands it.
    fetch: async (input) => {
      assert(input instanceof Request);
      dispatched.push(input);
      return success();
    },
  });
  await client.getUnread();
  await client.sendMessage(42, "Hello from a customer.");
  assert.equal(dispatched.length, 2);
  for (const request of dispatched) {
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "no-store");
    assert.equal(request.referrerPolicy, "no-referrer");
    assert.equal(
      request.headers.get("authorization"),
      `Bearer ${syntheticToken}`,
    );
  }
  assert.deepEqual(
    dispatched.map((request) => [
      request.method,
      new URL(request.url).pathname,
    ]),
    [
      ["GET", "/support-api/v1/unread"],
      ["POST", "/support-api/v1/conversations/42/messages"],
    ],
  );
});

test("a caller-built Request cannot relax the browser transport policy", async () => {
  const dispatched: Request[] = [];
  // Built the way a caller might, this Request is relaxed on every axis, which
  // is what the SDK has to override rather than inherit.
  const relaxed = new Request(`${baseUrl}/v1/unread`, {
    redirect: "follow",
    credentials: "include",
    cache: "default",
    referrerPolicy: "unsafe-url",
  });
  assert.equal(relaxed.redirect, "follow");
  assert.equal(relaxed.credentials, "include");
  assert.equal(relaxed.referrerPolicy, "unsafe-url");
  const client = makeClient({
    fetch: async (input, init) => {
      const request = dispatchedRequest(input, init);
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      assert.equal(request.referrerPolicy, "no-referrer");
      dispatched.push(request);
      return success();
    },
  });
  await client.getUnread();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.redirect, "error");
  assert.equal(dispatched[0]!.credentials, "omit");
  assert.equal(dispatched[0]!.referrerPolicy, "no-referrer");
});
