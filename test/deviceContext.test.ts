import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collectDeviceContext,
  DEVICE_CONTEXT_HEADER,
  encodeDeviceContext,
  lazyDeviceContext,
  parseUserAgent,
  parseUserAgentData,
  type DeviceContext,
  type DeviceEnvironment,
} from "../src/deviceContext.ts";
import { createDaykeeperWebClient } from "../src/index.ts";
import { SDK_VERSION } from "../src/version.ts";

const WEB = { sdk: "web", sdkVersion: SDK_VERSION };
const decode = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
const browser = (
  navigator: Record<string, unknown>,
  timeZone: unknown = "Europe/Amsterdam",
): DeviceEnvironment => ({
  hasWindowAndDocument: true,
  navigator,
  timeZone: () => timeZone,
});

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
  safariMacFrozen:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  chromeAndroidReduced:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
};

test("SDK_VERSION matches package.json", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(SDK_VERSION, manifest.version);
  assert.equal(DEVICE_CONTEXT_HEADER, "Daykeeper-Client");
});

test("encodes UTF-8 JSON as unpadded base64url", () => {
  const context: DeviceContext = {
    osName: "Zürich ✓ 日本",
    browserName: "a>>>???",
  };
  const json = JSON.stringify(context);
  const standard = Buffer.from(json).toString("base64");
  // The sample exercises every character the URL-safe alphabet replaces.
  assert.match(standard, /\+/);
  assert.match(standard, /\//);
  assert.match(standard, /=$/);
  const encoded = encodeDeviceContext(context);
  assert(encoded);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(encoded, Buffer.from(json).toString("base64url"));
  assert.deepEqual(decode(encoded), context);
});

test("encoding without TextEncoder or btoa sends nothing instead of throwing", () => {
  for (const name of ["TextEncoder", "btoa"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    try {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: undefined,
      });
      assert.equal(encodeDeviceContext({ platform: "web" }), null);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    }
  }
});

const userAgents: [string, string, number, Record<string, string>][] = [
  [
    "Chrome on Windows 10/11 (version ambiguous, left out)",
    UA.chromeWindows,
    0,
    { osName: "Windows", browserName: "Chrome", browserVersion: "129" },
  ],
  [
    "Edge on Windows 7",
    "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.78",
    0,
    {
      osName: "Windows",
      osVersion: "7",
      browserName: "Edge",
      browserVersion: "109.0.1518.78",
    },
  ],
  [
    "Opera on Windows 8.1",
    "Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0",
    0,
    {
      osName: "Windows",
      osVersion: "8.1",
      browserName: "Opera",
      browserVersion: "114",
    },
  ],
  [
    "Firefox on macOS (frozen 10.15 left out)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
    0,
    { osName: "macOS", browserName: "Firefox", browserVersion: "131" },
  ],
  [
    "Safari on macOS (frozen 10_15_7 left out)",
    UA.safariMacFrozen,
    0,
    { osName: "macOS", browserName: "Safari", browserVersion: "18.1" },
  ],
  [
    "Safari on an older macOS",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15",
    0,
    {
      osName: "macOS",
      osVersion: "10.14.6",
      browserName: "Safari",
      browserVersion: "14.1.2",
    },
  ],
  [
    "Safari on iPhone",
    UA.safariIphone,
    5,
    {
      osName: "iOS",
      osVersion: "17.4.1",
      deviceModel: "iPhone",
      browserName: "Safari",
      browserVersion: "17.4.1",
    },
  ],
  [
    "Safari on iPad",
    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    5,
    {
      osName: "iPadOS",
      osVersion: "16.6",
      deviceModel: "iPad",
      browserName: "Safari",
      browserVersion: "16.6",
    },
  ],
  [
    "Safari on iPad requesting the desktop site",
    UA.safariMacFrozen,
    5,
    {
      osName: "iPadOS",
      deviceModel: "iPad",
      browserName: "Safari",
      browserVersion: "18.1",
    },
  ],
  [
    "Safari on iPod touch",
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1",
    5,
    {
      osName: "iOS",
      osVersion: "15.8",
      deviceModel: "iPod",
      browserName: "Safari",
      browserVersion: "15.6.6",
    },
  ],
  [
    "Chrome on iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1",
    5,
    {
      osName: "iOS",
      osVersion: "17.5",
      deviceModel: "iPhone",
      browserName: "Chrome",
      browserVersion: "126.0.6478.153",
    },
  ],
  [
    "Firefox on iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
    5,
    {
      osName: "iOS",
      osVersion: "17.5",
      deviceModel: "iPhone",
      browserName: "Firefox",
      browserVersion: "127",
    },
  ],
  [
    "an iOS in-app web view (no browser claimed)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    5,
    { osName: "iOS", osVersion: "17.5", deviceModel: "iPhone" },
  ],
  [
    "Chrome on Android with the reduced UA (frozen version left out)",
    UA.chromeAndroidReduced,
    5,
    { osName: "Android", browserName: "Chrome", browserVersion: "129" },
  ],
  [
    "Edge on Android",
    `${UA.chromeAndroidReduced} EdgA/129.0.0.0`,
    5,
    { osName: "Android", browserName: "Edge", browserVersion: "129" },
  ],
  [
    "Samsung Internet on Android",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    5,
    {
      osName: "Android",
      osVersion: "14",
      browserName: "Samsung Internet",
      browserVersion: "25",
    },
  ],
  [
    "Firefox on Android",
    "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
    5,
    {
      osName: "Android",
      osVersion: "14",
      browserName: "Firefox",
      browserVersion: "131",
    },
  ],
  [
    "Android WebView",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36",
    5,
    {
      osName: "Android",
      osVersion: "13",
      browserName: "Android WebView",
      browserVersion: "116",
    },
  ],
  [
    "an old Android stock browser (not Safari)",
    "Mozilla/5.0 (Linux; U; Android 4.4.2; en-us; SM-T230) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30",
    5,
    { osName: "Android", osVersion: "4.4.2" },
  ],
  [
    "Chrome on ChromeOS",
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    0,
    { osName: "ChromeOS", browserName: "Chrome", browserVersion: "129" },
  ],
  [
    "Firefox on Linux",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    0,
    { osName: "Linux", browserName: "Firefox", browserVersion: "131" },
  ],
  ["an unrecognised user agent", "Mozilla/5.0 (compatible; Bot/1.0)", 0, {}],
];

for (const [name, userAgent, touchPoints, expected] of userAgents) {
  test(`parses ${name}`, () => {
    assert.deepEqual({ ...parseUserAgent(userAgent, touchPoints) }, expected);
  });
}

test("client hints: skip GREASE, prefer a specific brand over Chromium", () => {
  assert.deepEqual(
    parseUserAgentData({
      platform: "macOS",
      mobile: false,
      brands: [
        { brand: "Chromium", version: "129" },
        { brand: "Not=A?Brand", version: "8" },
        { brand: "Google Chrome", version: "129" },
      ],
    }),
    { osName: "macOS", browserName: "Chrome", browserVersion: "129" },
  );
  for (const grease of [
    "Not A(Brand",
    "Not)A;Brand",
    "Not_A Brand",
    "Not/A)Brand",
  ]) {
    assert.deepEqual(
      parseUserAgentData({
        platform: "Windows",
        brands: [
          { brand: grease, version: "99" },
          { brand: "Microsoft Edge", version: "129" },
          { brand: "Chromium", version: "129" },
        ],
      }),
      { osName: "Windows", browserName: "Edge", browserVersion: "129" },
    );
  }
  assert.deepEqual(
    parseUserAgentData({
      platform: "Chrome OS",
      brands: [
        { brand: "Not A(Brand", version: "99" },
        { brand: "Chromium", version: "129" },
      ],
    }),
    { osName: "ChromeOS", browserName: "Chromium", browserVersion: "129" },
  );
  assert.deepEqual(
    parseUserAgentData({ platform: "", brands: "nope" }),
    {},
    "unknown platforms and malformed brands are left out",
  );
  assert.deepEqual(parseUserAgentData(undefined), {});
});

test("collects a web context from client hints, with the UA as fallback", () => {
  const context = collectDeviceContext(
    WEB,
    browser({
      userAgent: UA.chromeMac,
      language: "nl-NL",
      maxTouchPoints: 0,
      userAgentData: {
        platform: "macOS",
        mobile: false,
        brands: [
          { brand: "Not A(Brand", version: "8" },
          { brand: "Chromium", version: "129" },
          { brand: "Brave", version: "129" },
        ],
      },
    }),
  );
  assert.deepEqual(context, {
    sdk: "web",
    sdkVersion: SDK_VERSION,
    platform: "web",
    osName: "macOS",
    browserName: "Brave",
    browserVersion: "129",
    locale: "nl-NL",
    timeZone: "Europe/Amsterdam",
  });

  // Hints and the string disagree about the OS: the string's version and
  // model are not attributed to the hinted OS.
  const mismatch = collectDeviceContext(
    WEB,
    browser({
      userAgent: UA.safariIphone,
      language: "en-US",
      userAgentData: { platform: "Android", brands: [] },
    }),
  );
  assert.equal(mismatch?.osName, "Android");
  assert.equal(mismatch?.osVersion, undefined);
  assert.equal(mismatch?.deviceModel, undefined);
  assert.equal(mismatch?.browserName, "Safari");

  // Without hints (Safari, Firefox) everything comes from the string.
  assert.deepEqual(
    collectDeviceContext(
      { sdk: "web-messenger", sdkVersion: "0.2.0" },
      browser({
        userAgent: UA.safariIphone,
        language: "ja",
        maxTouchPoints: 5,
      }),
    ),
    {
      sdk: "web-messenger",
      sdkVersion: "0.2.0",
      platform: "web",
      osName: "iOS",
      osVersion: "17.4.1",
      deviceModel: "iPhone",
      browserName: "Safari",
      browserVersion: "17.4.1",
      locale: "ja",
      timeZone: "Europe/Amsterdam",
    },
  );
});

test("omits what it cannot answer and never sends empty or oversized values", () => {
  const sparse = collectDeviceContext(
    { sdk: "web", sdkVersion: "  " },
    browser(
      {
        userAgent: "Mozilla/5.0 (compatible; Bot/1.0)",
        language: "",
        userAgentData: {
          brands: [{ brand: `  ${"B".repeat(150)}  `, version: "1" }],
        },
      },
      "Not a zone!",
    ),
  );
  assert(sparse);
  assert.deepEqual(Object.keys(sparse).sort(), [
    "browserName",
    "browserVersion",
    "platform",
    "sdk",
  ]);
  assert.equal(sparse.browserName, "B".repeat(100));
  for (const value of Object.values(sparse)) {
    assert.equal(typeof value, "string");
    assert.notEqual(value, "");
  }

  // A clip never splits a surrogate pair.
  const emoji = collectDeviceContext(
    WEB,
    browser({
      userAgent: "Mozilla/5.0",
      userAgentData: {
        brands: [{ brand: `${"x".repeat(99)}😀`, version: "1" }],
      },
    }),
  );
  assert.equal(emoji?.browserName, "x".repeat(99));

  // An invalid locale or a throwing time zone lookup is just left out.
  const odd = collectDeviceContext(WEB, {
    hasWindowAndDocument: true,
    navigator: { userAgent: UA.chromeWindows, language: "<script>" },
    timeZone: () => {
      throw new RangeError("no Intl");
    },
  });
  assert.equal(odd?.locale, undefined);
  assert.equal(odd?.timeZone, undefined);

  // Nothing that identifies the person, page or device is ever collected.
  const full = collectDeviceContext(
    WEB,
    browser({
      userAgent: UA.chromeWindows,
      language: "en-GB",
      userAgentData: { platform: "Windows", brands: [] },
      maxTouchPoints: 10,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      cookieEnabled: true,
    }),
  );
  assert(full);
  const allowed = new Set([
    "sdk",
    "sdkVersion",
    "platform",
    "osName",
    "osVersion",
    "deviceModel",
    "browserName",
    "browserVersion",
    "locale",
    "timeZone",
  ]);
  for (const key of Object.keys(full)) assert(allowed.has(key), key);
  const encoded = encodeDeviceContext(full);
  assert(encoded);
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  assert(!json.includes("Mozilla"), "never the user-agent string");
  assert(!json.includes("AppleWebKit"));
});

test("outside a browser nothing is collected or sent", () => {
  assert.equal(collectDeviceContext(WEB, browser({})), null);
  assert.equal(collectDeviceContext(WEB, { hasWindowAndDocument: true }), null);
  // Node 21+, Deno and Bun expose a navigator that is not a browser.
  for (const userAgent of ["Node.js/22", "Deno/2.0.0", "Bun/1.1.0"]) {
    assert.equal(
      collectDeviceContext(WEB, browser({ userAgent, language: "en" })),
      null,
    );
  }
  // A browser-looking navigator is not enough without a window and a
  // document (SSR with a polyfilled navigator, a worker).
  for (const hasWindowAndDocument of [false, undefined]) {
    assert.equal(
      collectDeviceContext(WEB, {
        hasWindowAndDocument,
        navigator: { userAgent: UA.chromeWindows, language: "en" },
      }),
      null,
    );
  }
  // The real globals of this Node process (navigator absent on Node 20).
  assert.equal(lazyDeviceContext(WEB)(), null);
});

test("the header value is computed once, lazily, and never throws", () => {
  let reads = 0;
  const getter = lazyDeviceContext(WEB, () => {
    reads += 1;
    return browser({ userAgent: UA.chromeWindows, language: "en-US" });
  });
  assert.equal(reads, 0, "nothing is read until a request needs it");
  const first = getter();
  assert(first);
  assert.equal(getter(), first);
  assert.equal(reads, 1);
  assert.deepEqual(decode(first), {
    sdk: "web",
    sdkVersion: SDK_VERSION,
    platform: "web",
    osName: "Windows",
    browserName: "Chrome",
    browserVersion: "129",
    locale: "en-US",
    timeZone: "Europe/Amsterdam",
  });

  const hostile = lazyDeviceContext(WEB, () => ({
    hasWindowAndDocument: true,
    navigator: new Proxy(
      {},
      {
        get() {
          throw new Error("hostile navigator");
        },
      },
    ),
  }));
  assert.equal(hostile(), null);
  const throwingEnvironment = lazyDeviceContext(WEB, () => {
    throw new Error("no environment");
  });
  assert.equal(throwingEnvironment(), null);
});

/**
 * Install page globals for one test: a navigator and, unless `page` is
 * false, a `window` and a `document`.
 */
function withNavigator(
  value: unknown,
  run: () => Promise<void>,
  page = true,
): Promise<void> {
  const globals: Record<string, unknown> = { navigator: value };
  if (page) {
    globals.window = {};
    globals.document = {};
  }
  const previous = Object.keys(globals).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, stub] of Object.entries(globals))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: () => stub,
    });
  return run().finally(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
}

const recordingClient = (
  options: { sendDeviceContext?: boolean } = {},
): { client: ReturnType<typeof createDaykeeperWebClient>; seen: Request[] } => {
  const seen: Request[] = [];
  const client = createDaykeeperWebClient({
    baseUrl: "https://support.example.com",
    getAccessToken: () => "synthetic-customer-token",
    fetch: async (input) => {
      seen.push(input as Request);
      return Response.json({ ok: true });
    },
    ...options,
  });
  return { client, seen };
};

test("every client request carries the Daykeeper-Client header in a browser", async () => {
  await withNavigator(
    {
      userAgent: UA.chromeAndroidReduced,
      language: "pt-BR",
      maxTouchPoints: 5,
      userAgentData: {
        platform: "Android",
        mobile: true,
        brands: [
          { brand: "Chromium", version: "129" },
          { brand: "Google Chrome", version: "129" },
          { brand: "Not=A?Brand", version: "8" },
        ],
      },
    },
    async () => {
      const { client, seen } = recordingClient();
      await client.getUnread();
      await client.listConversations();
      await client.sendMessage(7, "Hello");
      assert.equal(seen.length, 3);
      const values = seen.map((request) =>
        request.headers.get("daykeeper-client"),
      );
      assert(values[0]);
      assert(values.every((value) => value === values[0]));
      const context = decode(values[0]);
      assert.equal(context.sdk, "web");
      assert.equal(context.sdkVersion, SDK_VERSION);
      assert.equal(context.platform, "web");
      assert.equal(context.osName, "Android");
      assert.equal(context.osVersion, undefined);
      assert.equal(context.browserName, "Chrome");
      assert.equal(context.browserVersion, "129");
      assert.equal(context.locale, "pt-BR");
      assert.equal(typeof context.timeZone, "string");
      // The rest of the request is unchanged.
      assert.equal(
        seen[0]?.headers.get("authorization"),
        "Bearer synthetic-customer-token",
      );
    },
  );
});

test("sendDeviceContext: false sends no device context", async () => {
  let reads = 0;
  await withNavigator(
    new Proxy(
      { userAgent: UA.chromeWindows, language: "en" },
      {
        get(target, key) {
          reads += 1;
          return Reflect.get(target, key);
        },
      },
    ),
    async () => {
      const { client, seen } = recordingClient({ sendDeviceContext: false });
      await client.getUnread();
      assert.equal(seen[0]?.headers.has("daykeeper-client"), false);
      assert.equal(reads, 0, "the navigator is not even read");
    },
  );
  assert.throws(
    () =>
      recordingClient({
        sendDeviceContext: "no" as unknown as boolean,
      }),
    /sendDeviceContext must be a boolean/,
  );
});

test("no header outside a browser, and a hostile navigator never fails a request", async () => {
  const { client, seen } = recordingClient();
  await client.getUnread();
  assert.equal(seen[0]?.headers.has("daykeeper-client"), false);

  await withNavigator(
    new Proxy(
      {},
      {
        get() {
          throw new Error("hostile navigator");
        },
      },
    ),
    async () => {
      const hostile = recordingClient();
      assert.deepEqual(await hostile.client.getUnread(), { ok: true });
      assert.equal(hostile.seen[0]?.headers.has("daykeeper-client"), false);
    },
  );
});

test("DOM emulators (jsdom, happy-dom) send nothing even with a window and document", () => {
  for (const userAgent of [
    "Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0",
    "Mozilla/5.0 (X11; Linux x64) AppleWebKit/537.36 (KHTML, like Gecko) HappyDOM/0.0.0",
  ]) {
    assert.equal(
      collectDeviceContext(WEB, browser({ userAgent, language: "en-US" })),
      null,
      userAgent,
    );
  }
});

test("a touchscreen Mac whose client hints say macOS is not an iPad", () => {
  const mac = collectDeviceContext(
    WEB,
    browser({
      userAgent: UA.chromeMac,
      language: "en-US",
      maxTouchPoints: 10,
      userAgentData: {
        platform: "macOS",
        brands: [{ brand: "Google Chrome", version: "129" }],
      },
    }),
  );
  assert.equal(mac?.osName, "macOS");
  assert.equal(mac?.deviceModel, undefined);

  // Safari on iPad asking for desktop sites has no client hints: a Mac user
  // agent with a touch screen is still an iPad.
  const ipad = collectDeviceContext(
    WEB,
    browser({
      userAgent: UA.safariMacFrozen,
      language: "en-US",
      maxTouchPoints: 5,
    }),
  );
  assert.equal(ipad?.osName, "iPadOS");
  assert.equal(ipad?.deviceModel, "iPad");
});

test("browser names and versions are sent only as plain text", () => {
  const brand = (name: string, version = "129") =>
    collectDeviceContext(
      WEB,
      browser({
        userAgent: UA.chromeWindows,
        language: "en-US",
        userAgentData: {
          platform: "Windows",
          brands: [{ brand: name, version }],
        },
      }),
    );
  for (const unsafe of [
    "Evil<script>",
    "Evil>",
    'Say "hi"',
    "O'Brien",
    "Tick`",
    "Bell\u0007",
    "Line\nbreak",
    "C1\u0085",
  ]) {
    const context = brand(unsafe);
    assert.equal(context?.browserName, undefined, unsafe);
    assert.equal(context?.browserVersion, undefined, unsafe);
  }
  const badVersion = brand("Brave", '1"2');
  assert.equal(badVersion?.browserName, "Brave");
  assert.equal(badVersion?.browserVersion, undefined);
  assert.equal(brand("Opera GX", "114")?.browserName, "Opera GX");
});

test("no header with a browser navigator but no window/document, or under jsdom", async () => {
  await withNavigator(
    { userAgent: UA.chromeWindows, language: "en-US" },
    async () => {
      const { client, seen } = recordingClient();
      await client.getUnread();
      assert.equal(seen[0]?.headers.has("daykeeper-client"), false);
    },
    false,
  );
  await withNavigator(
    {
      userAgent:
        "Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0",
      language: "en-US",
    },
    async () => {
      const { client, seen } = recordingClient();
      await client.getUnread();
      assert.equal(seen[0]?.headers.has("daykeeper-client"), false);
    },
  );
});

test("the token provider never sees the header; a 401 GET retry sends it again", async () => {
  await withNavigator(
    { userAgent: UA.safariIphone, language: "en-US", maxTouchPoints: 5 },
    async () => {
      const contexts: unknown[] = [];
      const seen: Request[] = [];
      const client = createDaykeeperWebClient({
        baseUrl: "https://support.example.com",
        getAccessToken: (context) => {
          contexts.push(context);
          return `synthetic-token-${contexts.length}`;
        },
        fetch: async (input) => {
          seen.push(input as Request);
          return seen.length === 1
            ? Response.json({ error: "expired_token" }, { status: 401 })
            : Response.json({ unreadCount: 0 });
        },
      });
      assert.deepEqual(await client.getUnread(), { unreadCount: 0 });

      assert.equal(contexts.length, 2);
      for (const context of contexts) {
        assert.deepEqual(Object.keys(context as object).sort(), [
          "forceRefresh",
          "signal",
        ]);
      }
      assert.deepEqual(
        contexts.map(
          (context) => (context as { forceRefresh: boolean }).forceRefresh,
        ),
        [false, true],
      );

      assert.equal(seen.length, 2);
      const [first, retry] = seen.map((request) =>
        request.headers.get("daykeeper-client"),
      );
      assert(first);
      assert.equal(retry, first, "the retry carries the same header");
      assert.equal(decode(first).deviceModel, "iPhone");
      assert.equal(
        seen[1]?.headers.get("authorization"),
        "Bearer synthetic-token-2",
      );
    },
  );
});
