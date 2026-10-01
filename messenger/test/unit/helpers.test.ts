import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessengerApi,
  install,
  normalizeGatewayUrl,
  parseBootOptions,
} from "../../src/api.ts";
import { poweredByUrl } from "../../src/branding.ts";
import { contrast, onColor } from "../../src/color.ts";
import { parseRichText, safeHref } from "../../src/richText.ts";
import { relativeTime, toMillis } from "../../src/time.ts";

const KEY = "dk_pk_Test0000000000000000000000000001";

test("boot options are validated and defaulted", () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => warnings.push(message);
  try {
    assert.equal(parseBootOptions(undefined), null);
    assert.equal(parseBootOptions({ publishableKey: "dk_live_nope" }), null);
    assert.equal(
      parseBootOptions({
        publishableKey: KEY,
        gatewayUrl: "http://example.com",
      }),
      null,
    );
    const parsed = parseBootOptions({
      publishableKey: KEY,
      theme: "neon",
      position: "left",
      zIndex: -4,
      locale: "fr-CA",
      hideLauncher: "yes",
    });
    assert.deepEqual(parsed, {
      publishableKey: KEY,
      gatewayUrl: "https://gateway.mydaykeeper.com",
      locale: "fr-CA",
      theme: "auto",
      position: "left",
      hideLauncher: false,
      zIndex: 2147483000,
    });
    assert.equal(warnings.length, 3);
  } finally {
    console.warn = original;
  }
});

test("gateway URLs must be https, or http on literal loopback", () => {
  assert.equal(
    normalizeGatewayUrl("https://gw.example.com/"),
    "https://gw.example.com",
  );
  assert.equal(
    normalizeGatewayUrl("http://127.0.0.1:4411"),
    "http://127.0.0.1:4411",
  );
  assert.equal(normalizeGatewayUrl("http://localhost:1"), "http://localhost:1");
  assert.equal(normalizeGatewayUrl("http://10.0.0.2"), null);
  assert.equal(normalizeGatewayUrl("https://user:pw@gw.example.com"), null);
  assert.equal(normalizeGatewayUrl("https://gw.example.com/?x=1"), null);
  assert.equal(normalizeGatewayUrl("javascript:alert(1)"), null);
  assert.equal(normalizeGatewayUrl(42), null);
});

test("install replaces the snippet stub and replays its queue", () => {
  const calls: unknown[][] = [];
  const stub = Object.assign((...args: unknown[]) => calls.push(args), {
    q: [] as ArrayLike<unknown>[],
  });
  const received: unknown[] = [];
  stub.q.push(["on", "unreadCountChange", (n: unknown) => received.push(n)]);
  stub.q.push(["on", "bogus", () => undefined]);
  const win = { Daykeeper: stub, setTimeout } as never as Parameters<
    typeof install
  >[0];
  const original = console.warn;
  const warnings: unknown[] = [];
  console.warn = (m: unknown) => warnings.push(m);
  try {
    install(win);
    const api = (win as { Daykeeper: { version: string } }).Daykeeper;
    assert.notEqual(api, stub);
    assert.equal(typeof api.version, "string");
    assert.equal(warnings.length, 1);
    // A second copy of the script is a no-op.
    install(win);
    assert.equal((win as { Daykeeper: unknown }).Daykeeper, api);
    const direct = createMessengerApi(win);
    assert.equal(direct("show"), undefined);
    assert.equal(typeof direct("on", "ready", () => undefined), "function");
  } finally {
    console.warn = original;
  }
});

test("rich text links only safe schemes and never parses HTML", () => {
  assert.deepEqual(parseRichText("Hi **there** `x` <b>no</b>"), [
    { kind: "text", text: "Hi " },
    { kind: "bold", text: "there" },
    { kind: "text", text: " " },
    { kind: "code", text: "x" },
    { kind: "text", text: " <b>no</b>" },
  ]);
  assert.deepEqual(parseRichText("See https://example.com/a?b=1."), [
    { kind: "text", text: "See " },
    {
      kind: "link",
      text: "https://example.com/a?b=1",
      href: "https://example.com/a?b=1",
    },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(parseRichText("[click](javascript:alert(1))")[0], {
    kind: "text",
    text: "[click](javascript:alert(1))",
  });
  assert.deepEqual(parseRichText("[docs](https://example.com/docs)"), [
    { kind: "link", text: "docs", href: "https://example.com/docs" },
  ]);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("https://u:p@example.com"), null);
  assert.equal(safeHref("mailto:help@example.com"), "mailto:help@example.com");
});

test("time helpers accept seconds, ms, and ISO; relative strings via Intl", () => {
  assert.equal(toMillis(1_800_000_000), 1_800_000_000_000);
  assert.equal(toMillis(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(toMillis("1800000000"), 1_800_000_000_000);
  assert.equal(
    toMillis("2027-01-15T08:00:00Z"),
    Date.parse("2027-01-15T08:00:00Z"),
  );
  assert.equal(toMillis(null), null);
  assert.equal(toMillis("nope"), null);
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(relativeTime(now - 10_000, now, "en"), "Just now");
  assert.match(relativeTime(now - 5 * 60_000, now, "en"), /5 min/);
  assert.match(relativeTime(now - 3 * 3_600_000, now, "en"), /3 hr/);
  assert.equal(relativeTime(now - 26 * 3_600_000, now, "en"), "yesterday");
  assert.match(relativeTime(now - 30 * 86_400_000, now, "en"), /Aug 27/);
});

test("accent text colour meets the better contrast", () => {
  assert.equal(onColor("#000000"), "#ffffff");
  assert.equal(onColor("#ffe45c"), "#000000");
  assert.equal(onColor("#2d4a3e"), "#ffffff");
  assert.ok(contrast("#2d4a3e", "#ffffff") > 4.5);
});

test("the Powered by link is tagged as a widget referral from the host site", () => {
  assert.equal(
    poweredByUrl("support.attachedapp.com"),
    "https://www.mydaykeeper.com/widget?ref=widget&utm_source=support.attachedapp.com&utm_medium=widget&utm_campaign=branding",
  );
  // A page without a host (a file:// preview) still carries the ref.
  assert.equal(
    poweredByUrl(""),
    "https://www.mydaykeeper.com/widget?ref=widget&utm_medium=widget&utm_campaign=branding",
  );
  // The host is encoded, never spliced into the URL.
  const url = new URL(poweredByUrl("a.test&ref=other#x"));
  assert.equal(url.searchParams.get("ref"), "widget");
  assert.equal(url.searchParams.get("utm_source"), "a.test&ref=other#x");
  assert.equal(url.hash, "");
});
