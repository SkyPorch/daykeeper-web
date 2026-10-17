import assert from "node:assert/strict";
import test from "node:test";
import { lazyDeviceContext } from "../../../src/deviceContext.ts";
import { parseBootOptions } from "../../src/api.ts";
import { MessengerController } from "../../src/controller.ts";
import { fetchProfile } from "../../src/profile.ts";
import { VisitorSession, type SessionGrant } from "../../src/session.ts";
import { createVisitorStore } from "../../src/storage.ts";

const KEY = "dk_pk_Test0000000000000000000000000001";
const GATEWAY = "https://gateway.example.test";
const HEADER = "eyJzZGsiOiJ3ZWItbWVzc2VuZ2VyIn0";
const BROWSER_NAVIGATOR = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  language: "en-US",
};

type Seen = { url: string; headers: Headers };

/** Record every fetch, whether it was given a Request or a URL plus init. */
async function withFetch(
  answer: (url: string) => Response,
  run: (seen: Seen[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    seen.push({ url: request.url, headers: request.headers });
    return answer(request.url);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

/** A page: browser navigator plus `window` and `document`. */
async function withBrowserNavigator(run: () => Promise<void>): Promise<void> {
  const globals: Record<string, unknown> = {
    navigator: BROWSER_NAVIGATOR,
    window: {},
    document: {},
  };
  const previous = Object.keys(globals).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, stub] of Object.entries(globals))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: () => stub,
    });
  try {
    await run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
};

function controllerWith(deviceContext?: () => string | null) {
  const grant: SessionGrant = {
    token: "synthetic.visitor-token",
    expiresAt: Date.now() + 300_000,
    gatewayUrl: GATEWAY,
    visitorId: "v_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    inbox: {
      name: "Example",
      greeting: null,
      accentColor: null,
      logoUrl: null,
    },
  };
  const session = {
    grant,
    ensure: async () => grant,
    token: async () => grant.token,
    reset: () => {},
  } as unknown as VisitorSession;
  return new MessengerController({
    session,
    store: createVisitorStore(KEY, () => null),
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    ...(deviceContext ? { deviceContext } : {}),
  });
}

const gatewayAnswer = (url: string) =>
  url.endsWith("/v1/messenger")
    ? Response.json({ data: { team: [], replyTime: null } })
    : Response.json({ conversations: [] });

test("the profile fetch sends the device context it is given, and none otherwise", async () => {
  await withFetch(gatewayAnswer, async (seen) => {
    await fetchProfile(GATEWAY, "tok", HEADER);
    await fetchProfile(GATEWAY, "tok", null);
    await fetchProfile(GATEWAY, "tok");
    assert.equal(seen[0]?.headers.get("daykeeper-client"), HEADER);
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer tok");
    assert.equal(seen[1]?.headers.has("daykeeper-client"), false);
    assert.equal(seen[2]?.headers.has("daykeeper-client"), false);
  });
});

test("the controller's client and profile requests carry the messenger's header", async () => {
  let computed = 0;
  await withFetch(gatewayAnswer, async (seen) => {
    const controller = controllerWith(() => {
      computed += 1;
      return HEADER;
    });
    controller.open();
    await settle();
    controller.shutdown();
    const paths = seen.map((entry) => new URL(entry.url).pathname);
    assert(paths.includes("/v1/conversations"), paths.join());
    assert(paths.includes("/v1/messenger"), paths.join());
    for (const entry of seen)
      assert.equal(entry.headers.get("daykeeper-client"), HEADER, entry.url);
  });
  assert(computed > 0);
});

test("without a messenger header the bundled client never falls back to sdk web", async () => {
  await withBrowserNavigator(() =>
    withFetch(gatewayAnswer, async (seen) => {
      // This stub is a page: the plain headless SDK would describe it.
      assert(lazyDeviceContext({ sdk: "web", sdkVersion: "0.0.0" })());
      for (const controller of [controllerWith(), controllerWith(() => null)]) {
        controller.open();
        await settle();
        controller.shutdown();
      }
      assert(seen.length >= 4);
      for (const entry of seen)
        assert.equal(entry.headers.has("daykeeper-client"), false, entry.url);
    }),
  );
});

test("boot options: sendDeviceContext is on unless a spelling of off is given", () => {
  const parsed = (sendDeviceContext?: unknown) =>
    parseBootOptions({ publishableKey: KEY, sendDeviceContext })
      ?.sendDeviceContext;
  assert.equal(
    parseBootOptions({ publishableKey: KEY })?.sendDeviceContext,
    true,
  );
  // Snippets and tag-manager config pass strings and numbers.
  for (const off of [false, "false", 0, "0"]) assert.equal(parsed(off), false);
  for (const on of [true, "true", 1, "1", "", null, undefined, "no"])
    assert.equal(parsed(on), true, String(on));
});

test("the visitor-session exchange never sends the header (strict control-plane schema)", async () => {
  await withBrowserNavigator(() =>
    withFetch(
      () =>
        Response.json({
          data: {
            token: "synthetic.visitor-token",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            gatewayUrl: GATEWAY,
            visitor: {
              id: "v_aaaaaaaaaaaaaaaaaaaaaaaaaa",
              secret: "a".repeat(43),
            },
            inbox: { name: "Example" },
          },
        }),
      async (seen) => {
        const session = new VisitorSession({
          publishableKey: KEY,
          gatewayUrl: GATEWAY,
          store: createVisitorStore(KEY, () => null),
        });
        await session.ensure();
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.headers.has("daykeeper-client"), false);
      },
    ),
  );
});
