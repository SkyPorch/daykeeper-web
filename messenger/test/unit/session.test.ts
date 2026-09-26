import assert from "node:assert/strict";
import test from "node:test";
import { MessengerError } from "../../src/errors.ts";
import { parseExpiry, VisitorSession } from "../../src/session.ts";
import { createVisitorStore } from "../../src/storage.ts";

const KEY = "dk_pk_Test0000000000000000000000000001";
const GATEWAY = "https://gateway.example.test";
const V1 = "v_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const V2 = "v_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const S1 = "a".repeat(43);
const S2 = "b".repeat(43);

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function grantBody(
  visitor: { id: string; secret?: string },
  expiresAt: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    data: {
      token: `tok.${visitor.id}.${Math.random().toString(36).slice(2)}`,
      tokenType: "Bearer",
      expiresAt,
      gatewayUrl: GATEWAY,
      visitor,
      inbox: { name: "Example", greeting: "Hello", accentColor: "#1A2B3C" },
      ...extra,
    },
  };
}

function harness(
  responder: (call: Call, index: number) => Response | Promise<Response>,
  clock = { now: 1_800_000_000_000 },
) {
  const calls: Call[] = [];
  const store = createVisitorStore(KEY, () => null);
  const session = new VisitorSession({
    publishableKey: KEY,
    gatewayUrl: GATEWAY,
    locale: "en-GB",
    store,
    now: () => clock.now,
    fetch: async (url, init) => {
      const call = {
        url: String(url),
        init: init!,
        body: JSON.parse(String(init!.body)),
      };
      calls.push(call);
      return responder(call, calls.length - 1);
    },
  });
  return { calls, store, session, clock };
}

const iso = (ms: number) => new Date(ms).toISOString();

test("mints a visitor on first exchange and stores the secret once", async () => {
  const { calls, store, session, clock } = harness(() =>
    Response.json(grantBody({ id: V1, secret: S1 }, iso(1_800_000_300_000)), {
      status: 201,
    }),
  );
  const grant = await session.ensure();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${GATEWAY}/v1/visitor-sessions`);
  assert.deepEqual(calls[0]!.body, { publishableKey: KEY, locale: "en-GB" });
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(calls[0]!.init.referrerPolicy, "no-referrer");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.deepEqual(store.read(), {
    visitorId: V1,
    secret: S1,
    hasConversation: false,
  });
  assert.equal(grant.expiresAt, 1_800_000_300_000);
  assert.deepEqual(grant.inbox, {
    name: "Example",
    greeting: "Hello",
    accentColor: "#1a2b3c",
  });
  assert.ok(clock.now);
});

test("resumes a stored visitor without rewriting storage", async () => {
  const { calls, store, session } = harness(() =>
    Response.json(grantBody({ id: V1 }, iso(1_800_000_300_000))),
  );
  store.write({ visitorId: V1, secret: S1, hasConversation: true });
  await session.ensure();
  assert.deepEqual(calls[0]!.body.visitor, { id: V1, secret: S1 });
  assert.deepEqual(store.read(), {
    visitorId: V1,
    secret: S1,
    hasConversation: true,
  });
});

test("visitor_proof_invalid drops the stored visitor and mints a new one", async () => {
  const { calls, store, session } = harness((call) =>
    call.body.visitor
      ? Response.json({ error: "visitor_proof_invalid" }, { status: 401 })
      : Response.json(
          grantBody({ id: V2, secret: S2 }, iso(1_800_000_300_000)),
          {
            status: 201,
          },
        ),
  );
  store.write({ visitorId: V1, secret: S1, hasConversation: true });
  const grant = await session.ensure();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.visitor, undefined);
  assert.equal(grant.visitorId, V2);
  assert.deepEqual(store.read(), {
    visitorId: V2,
    secret: S2,
    hasConversation: false,
  });
});

test("re-mints only once: a second proof failure surfaces", async () => {
  const { calls, store, session } = harness(() =>
    Response.json({ error: "visitor_proof_invalid" }, { status: 401 }),
  );
  store.write({ visitorId: V1, secret: S1, hasConversation: true });
  await assert.rejects(session.ensure(), (error: MessengerError) => {
    assert.equal(error.code, "visitor_proof_invalid");
    return true;
  });
  assert.equal(calls.length, 2);
});

test("caches the token until 60 s before expiry, then refreshes", async () => {
  const clock = { now: 1_800_000_000_000 };
  const { calls, session } = harness(
    (_call, index) =>
      Response.json(
        grantBody(
          index === 0 ? { id: V1, secret: S1 } : { id: V1 },
          iso(clock.now + 300_000),
        ),
        { status: index === 0 ? 201 : 200 },
      ),
    clock,
  );
  const first = await session.token();
  clock.now += 239_000; // 61 s left
  assert.equal(await session.token(), first);
  assert.equal(calls.length, 1);
  clock.now += 2_000; // 59 s left
  const second = await session.token();
  assert.notEqual(second, first);
  assert.equal(calls.length, 2);
  // A rejected token forces an exchange even when the cache looks fresh.
  const third = await session.token(true);
  assert.notEqual(third, second);
  assert.equal(calls.length, 3);
});

test("concurrent callers share one exchange", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { calls, session } = harness(async () => {
    await gate;
    return Response.json(
      grantBody({ id: V1, secret: S1 }, iso(1_800_000_300_000)),
      { status: 201 },
    );
  });
  const pending = [session.token(), session.token(), session.ensure()];
  release();
  const [a, b, c] = await Promise.all(pending);
  assert.equal(a, b);
  assert.equal(typeof c, "object");
  assert.equal(calls.length, 1);
});

test("maps gateway error codes and hides everything else", async () => {
  const cases: [Response | Error, string, boolean][] = [
    [
      Response.json({ error: "web_client_unavailable" }, { status: 404 }),
      "web_client_unavailable",
      false,
    ],
    [
      Response.json({ error: "origin_not_allowed" }, { status: 403 }),
      "origin_not_allowed",
      false,
    ],
    [
      Response.json({ error: "invalid_request" }, { status: 400 }),
      "invalid_request",
      false,
    ],
    [
      Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
      "temporarily_unavailable",
      true,
    ],
    [
      Response.json({ error: "Some prose from a proxy" }, { status: 502 }),
      "temporarily_unavailable",
      true,
    ],
    [
      new Response("<html>teapot</html>", { status: 418 }),
      "invalid_request",
      false,
    ],
    [new TypeError("Failed to fetch"), "network_error", true],
    [Response.json({ data: { token: "" } }), "temporarily_unavailable", true],
    [Response.json(grantBody({ id: V1 }, 0)), "temporarily_unavailable", true],
  ];
  for (const [outcome, code, retryable] of cases) {
    const { session } = harness(() => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    await assert.rejects(session.ensure(), (error: MessengerError) => {
      assert.equal(error.code, code, `for ${code}`);
      assert.equal(error.retryable, retryable, `retryable for ${code}`);
      return true;
    });
  }
});

test("reset discards an in-flight exchange", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { session } = harness(async () => {
    await gate;
    return Response.json(
      grantBody({ id: V1, secret: S1 }, iso(1_800_000_300_000)),
      { status: 201 },
    );
  });
  const pending = session.ensure();
  session.reset();
  release();
  await pending;
  assert.equal(session.grant, null);
});

test("parseExpiry accepts ISO, seconds, milliseconds and the JWT exp", () => {
  const now = 1_800_000_000_000;
  assert.equal(parseExpiry(iso(now + 300_000), "t", now), now + 300_000);
  assert.equal(parseExpiry((now + 300_000) / 1000, "t", now), now + 300_000);
  assert.equal(parseExpiry(now + 300_000, "t", now), now + 300_000);
  const payload = Buffer.from(
    JSON.stringify({ exp: (now + 120_000) / 1000 }),
  ).toString("base64url");
  assert.equal(parseExpiry("garbage", `h.${payload}.s`, now), now + 120_000);
  assert.equal(parseExpiry(undefined, "opaque", now), now + 240_000);
  // A token carrying iat/exp is timed from our own clock, so a visitor whose
  // clock runs 10 minutes fast still gets the full five-minute lifetime.
  const skewed = Buffer.from(
    JSON.stringify({ iat: now / 1000 - 600, exp: now / 1000 - 300 }),
  ).toString("base64url");
  assert.equal(
    parseExpiry(iso(now - 300_000), `h.${skewed}.s`, now),
    now + 300_000,
  );
  assert.equal(parseExpiry(iso(now - 1), "opaque", now), now + 240_000);
});

test("a session answer can never move the gateway to another origin", async () => {
  for (const gatewayUrl of [
    "https://evil.example.test",
    "http://gateway.example.test",
    "https://gateway.example.test.evil.test",
    "https://user:pass@gateway.example.test",
    "https://gateway.example.test/?x=1",
    "javascript:alert(1)",
    42,
  ]) {
    const { session } = harness(() =>
      Response.json(
        grantBody({ id: V1, secret: S1 }, iso(1_800_000_300_000), {
          gatewayUrl,
        }),
        { status: 201 },
      ),
    );
    const grant = await session.ensure();
    assert.equal(grant.gatewayUrl, GATEWAY, String(gatewayUrl));
  }
  // The same origin with a path prefix is kept, without a trailing slash.
  const { session } = harness(() =>
    Response.json(
      grantBody({ id: V1, secret: S1 }, iso(1_800_000_300_000), {
        gatewayUrl: `${GATEWAY}/cell-a/`,
      }),
      { status: 201 },
    ),
  );
  assert.equal((await session.ensure()).gatewayUrl, `${GATEWAY}/cell-a`);
});
