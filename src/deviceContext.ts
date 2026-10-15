/**
 * Default device context: every gateway request describes the browser it
 * runs in (OS, browser, language, time zone and this SDK's version) in a
 * `Daykeeper-Client` header, so agents see it on the contact with no host
 * code, the way Intercom's Messenger does.
 *
 * The value is base64url (no padding) of UTF-8 JSON with optional string
 * fields. It never carries the user-agent string, a URL, the page title, a
 * referrer, screen metrics or any identifier. A field the browser cannot
 * answer cheaply and synchronously is left out. Outside a browser (Node, SSR)
 * nothing is sent. Nothing here ever throws.
 */

export const DEVICE_CONTEXT_HEADER = "Daykeeper-Client";

/** The gateway ignores a longer header. */
const MAX_HEADER_LENGTH = 4096;
const MAX_FIELD_LENGTH = 100;
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

export interface DaykeeperSdkIdentity {
  /** "web" for the headless client, "web-messenger" for the messenger. */
  sdk: string;
  sdkVersion: string;
}

export interface DeviceContext {
  sdk?: string;
  sdkVersion?: string;
  platform?: "web";
  osName?: string;
  osVersion?: string;
  deviceModel?: string;
  browserName?: string;
  browserVersion?: string;
  locale?: string;
  timeZone?: string;
}

/** What the collector reads. Defaults to the real browser globals. */
export interface DeviceEnvironment {
  navigator?: unknown;
  timeZone?: () => unknown;
}

/**
 * Internal client option, not exported from the package entry: lets the
 * bundled messenger hand the headless client its own (lazily computed)
 * header value, so the gateway sees `web-messenger` rather than `web`.
 */
export const DEVICE_CONTEXT_SOURCE = Symbol("daykeeper.deviceContextSource");

export interface DeviceContextSourceOption {
  [DEVICE_CONTEXT_SOURCE]?: () => string | null;
}

export interface UserAgentFacts {
  osName?: string;
  osVersion?: string;
  deviceModel?: string;
  browserName?: string;
  browserVersion?: string;
}

/**
 * A deliberately small parse of the major browsers and operating systems.
 * Versions that browsers freeze in their user-agent string (macOS 10.15.7,
 * Windows NT 10.0 for both 10 and 11, Chromium's reduced "Android 10; K")
 * are dropped rather than reported as fact.
 */
export function parseUserAgent(
  userAgent: string,
  maxTouchPoints = 0,
): UserAgentFacts {
  const facts: UserAgentFacts = {};
  let match: RegExpMatchArray | null;

  if ((match = userAgent.match(/\((iPhone|iPad|iPod)\b([^)]*)\)/))) {
    const device = match[1] as "iPhone" | "iPad" | "iPod";
    facts.osName = device === "iPad" ? "iPadOS" : "iOS";
    facts.deviceModel = device;
    const version = match[2]?.match(/\bOS (\d+(?:_\d+)*)/)?.[1];
    if (version) facts.osVersion = version.replace(/_/g, ".");
  } else if ((match = userAgent.match(/\bAndroid(?: (\d+(?:\.\d+)*))?/))) {
    facts.osName = "Android";
    const reduced = /\bAndroid 10; K\)/.test(userAgent);
    if (match[1] && !reduced) facts.osVersion = match[1];
  } else if (/\bCrOS\b/.test(userAgent)) {
    facts.osName = "ChromeOS";
  } else if ((match = userAgent.match(/\bWindows NT (\d+\.\d+)/))) {
    facts.osName = "Windows";
    const version = WINDOWS_VERSIONS[match[1] ?? ""];
    if (version) facts.osVersion = version;
  } else if (/\bMacintosh\b/.test(userAgent)) {
    if (maxTouchPoints > 1) {
      // iPadOS Safari asks for desktop sites with a Mac user agent. A touch
      // screen gives it away; its OS version is not in the string.
      facts.osName = "iPadOS";
      facts.deviceModel = "iPad";
    } else {
      facts.osName = "macOS";
      const version = userAgent
        .match(/\bMac OS X (\d+(?:[._]\d+)*)/)?.[1]
        ?.replace(/_/g, ".");
      if (version && !/^10\.15(?:\.|$)/.test(version))
        facts.osVersion = version;
    }
  } else if (/\bLinux\b/.test(userAgent)) {
    facts.osName = "Linux";
  }

  for (const [name, pattern] of BROWSERS) {
    // Old Android stock browsers also claim "Version/4.0 … Safari/".
    if (name === "Safari" && facts.osName === "Android") break;
    match = userAgent.match(pattern);
    if (!match) continue;
    facts.browserName = name;
    const version = trimVersion(match[1]);
    if (version) facts.browserVersion = version;
    break;
  }
  return facts;
}

const WINDOWS_VERSIONS: Record<string, string> = {
  "6.1": "7",
  "6.2": "8",
  "6.3": "8.1",
  // "10.0" is both Windows 10 and Windows 11: left out.
};

// Order matters: Chromium-based browsers also say "Chrome/", and nearly
// everything says "Safari/".
const BROWSERS: [string, RegExp][] = [
  ["Samsung Internet", /\bSamsungBrowser\/(\d[\d.]*)/],
  ["Opera", /\b(?:OPR|OPT|OPiOS)\/(\d[\d.]*)/],
  ["Edge", /\b(?:Edg|EdgA|EdgiOS|Edge)\/(\d[\d.]*)/],
  ["Firefox", /\b(?:Firefox|FxiOS)\/(\d[\d.]*)/],
  ["Android WebView", /; wv\).*\bChrome\/(\d[\d.]*)/],
  ["Chrome", /\b(?:CriOS|Chrome)\/(\d[\d.]*)/],
  ["Safari", /\bVersion\/(\d[\d.]*).*\bSafari\//],
];

function trimVersion(value: string | undefined): string | undefined {
  // Chromium reduces its version to "120.0.0.0"; report "120".
  const version = value?.replace(/(?:\.0)+$/, "");
  return version || undefined;
}

const UA_DATA_PLATFORMS: Record<string, string> = {
  Windows: "Windows",
  macOS: "macOS",
  Linux: "Linux",
  Android: "Android",
  "Chrome OS": "ChromeOS",
  ChromeOS: "ChromeOS",
  "Chromium OS": "ChromeOS",
  iOS: "iOS",
};

const BRAND_NAMES: Record<string, string> = {
  "Google Chrome": "Chrome",
  "Microsoft Edge": "Edge",
};

/** Low-entropy User-Agent Client Hints only; never getHighEntropyValues. */
export function parseUserAgentData(
  data: unknown,
): Pick<UserAgentFacts, "osName" | "browserName" | "browserVersion"> {
  const facts: Pick<
    UserAgentFacts,
    "osName" | "browserName" | "browserVersion"
  > = {};
  if (!isRecord(data)) return facts;
  if (typeof data.platform === "string") {
    const osName = UA_DATA_PLATFORMS[data.platform];
    if (osName) facts.osName = osName;
  }
  const brands = (Array.isArray(data.brands) ? data.brands : []).filter(
    (entry): entry is { brand: string; version: string } =>
      isRecord(entry) &&
      typeof entry.brand === "string" &&
      typeof entry.version === "string" &&
      entry.brand.trim() !== "" &&
      // GREASE entries: "Not A(Brand", "Not)A;Brand", "Not_A Brand", ...
      !/^not[^a-z]*a[^a-z]*brand$/i.test(entry.brand.trim()),
  );
  const brand =
    brands.find((entry) => entry.brand.trim() !== "Chromium") ?? brands[0];
  if (brand) {
    const name = brand.brand.trim();
    facts.browserName = BRAND_NAMES[name] ?? name;
    const version = trimVersion(brand.version.trim());
    if (version) facts.browserVersion = version;
  }
  return facts;
}

/**
 * The context for this browser, or null outside one. Pure apart from reading
 * `environment` (defaults to the real globals).
 */
export function collectDeviceContext(
  identity: DaykeeperSdkIdentity,
  environment: DeviceEnvironment = browserEnvironment(),
): DeviceContext | null {
  const nav = environment.navigator;
  if (!isRecord(nav)) return null;
  const userAgent = nav.userAgent;
  // Node, Deno and Bun expose a navigator too ("Node.js/22"); every browser's
  // user agent starts with "Mozilla/".
  if (typeof userAgent !== "string" || !/^Mozilla\//.test(userAgent))
    return null;

  const touchPoints =
    typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : 0;
  const parsed = parseUserAgent(userAgent, touchPoints);
  const hints = parseUserAgentData(nav.userAgentData);
  const osName = hints.osName ?? parsed.osName;
  // A version or model from the string only counts when the string agrees
  // with the client hints about which OS this is.
  const sameOs = parsed.osName === osName;
  const browser = hints.browserName ? hints : parsed;

  const context: DeviceContext = {};
  assign(context, "sdk", identity.sdk);
  assign(context, "sdkVersion", identity.sdkVersion);
  context.platform = "web";
  assign(context, "osName", osName);
  if (sameOs) {
    assign(context, "osVersion", parsed.osVersion);
    assign(context, "deviceModel", parsed.deviceModel);
  }
  assign(context, "browserName", browser.browserName);
  if (browser.browserName) {
    assign(context, "browserVersion", browser.browserVersion);
  }
  const locale = typeof nav.language === "string" ? nav.language.trim() : "";
  if (locale.length <= 35 && LOCALE.test(locale)) context.locale = locale;
  let zone: unknown;
  try {
    zone = environment.timeZone?.();
  } catch {
    zone = undefined;
  }
  if (typeof zone === "string" && zone.length <= 64 && TIME_ZONE.test(zone))
    context.timeZone = zone;
  return context;
}

/** base64url (URL-safe alphabet, no padding) of the UTF-8 JSON, or null. */
export function encodeDeviceContext(context: DeviceContext): string | null {
  try {
    if (typeof TextEncoder !== "function" || typeof btoa !== "function")
      return null;
    const bytes = new TextEncoder().encode(JSON.stringify(context));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1)
      binary += String.fromCharCode(bytes[index] as number);
    const value = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return value && value.length <= MAX_HEADER_LENGTH ? value : null;
  } catch {
    return null;
  }
}

/**
 * A getter for the header value, computed on first use and then reused.
 * Returns null (send no header) outside a browser or on any failure.
 */
export function lazyDeviceContext(
  identity: DaykeeperSdkIdentity,
  environment?: () => DeviceEnvironment,
): () => string | null {
  let value: string | null | undefined;
  return () => {
    if (value === undefined) {
      try {
        const context = collectDeviceContext(
          identity,
          environment ? environment() : browserEnvironment(),
        );
        value = context ? encodeDeviceContext(context) : null;
      } catch {
        value = null;
      }
    }
    return value;
  };
}

function browserEnvironment(): DeviceEnvironment {
  return {
    navigator: typeof navigator === "undefined" ? undefined : navigator,
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function assign(
  context: DeviceContext,
  key: Exclude<keyof DeviceContext, "platform">,
  value: string | undefined,
): void {
  const text = clip(value);
  if (text) context[key] = text;
}

/** Trimmed, at most 100 UTF-16 units without splitting a surrogate pair. */
function clip(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (text.length > MAX_FIELD_LENGTH) {
    text = text.slice(0, MAX_FIELD_LENGTH);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    !Array.isArray(value)
  );
}
