import { MessengerError, type MessengerErrorCode } from "./errors.ts";
import {
  VISITOR_ID_PATTERN,
  VISITOR_SECRET_PATTERN,
  type VisitorStore,
} from "./storage.ts";

/**
 * Anonymous visitor session exchange (SPEC §3).
 *
 * `POST {gatewayUrl}/v1/visitor-sessions` trades the site's publishable key —
 * plus, for a returning visitor, their stored id and secret — for a
 * five-minute customer token. The token is held in memory only; the visitor
 * secret is the only thing persisted, and only after the server minted it.
 */

export interface InboxInfo {
  name: string;
  greeting: string | null;
  accentColor: string | null;
}

export interface SessionGrant {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  gatewayUrl: string;
  inbox: InboxInfo;
  visitorId: string;
}

export interface VisitorSessionOptions {
  publishableKey: string;
  gatewayUrl: string;
  locale?: string;
  store: VisitorStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Refresh this long before the server's stated expiry. */
export const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const FALLBACK_LIFETIME_MS = 240_000;
const MAX_TOKEN_LENGTH = 16_384;
const KNOWN_CODES = new Set<MessengerErrorCode>([
  "invalid_request",
  "origin_not_allowed",
  "web_client_unavailable",
  "visitor_proof_invalid",
  "temporarily_unavailable",
]);

export class VisitorSession {
  readonly #options: Required<
    Pick<VisitorSessionOptions, "publishableKey" | "gatewayUrl" | "store">
  > &
    VisitorSessionOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  #grant: SessionGrant | null = null;
  #inflight: Promise<SessionGrant> | null = null;
  #generation = 0;

  constructor(options: VisitorSessionOptions) {
    this.#options = options;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl.call(globalThis, input, init);
    this.#now = options.now ?? Date.now;
  }

  get grant(): SessionGrant | null {
    return this.#grant;
  }

  /**
   * A token valid for at least REFRESH_MARGIN_MS more, exchanging when the
   * cached one is missing or close to expiry. `force` discards the cached
   * token first (the gateway rejected it). Concurrent callers share one
   * exchange.
   */
  async token(force = false): Promise<string> {
    return (await this.ensure(force)).token;
  }

  async ensure(force = false): Promise<SessionGrant> {
    if (force) this.#grant = null;
    const grant = this.#grant;
    if (grant && grant.expiresAt - this.#now() > REFRESH_MARGIN_MS) {
      return grant;
    }
    if (!this.#inflight) {
      const generation = this.#generation;
      let exchange!: Promise<SessionGrant>;
      exchange = this.#exchange(generation)
        .then((next) => {
          if (generation !== this.#generation) {
            // A caller may still be awaiting this exchange after shutdown
            // forgot the visitor. Never hand that stale token to an operation
            // that could dispatch a message with the forgotten identity.
            throw new MessengerError("unknown");
          }
          this.#grant = next;
          return next;
        })
        .finally(() => {
          if (this.#inflight === exchange) this.#inflight = null;
        });
      this.#inflight = exchange;
    }
    return this.#inflight;
  }

  /** Forget the in-memory token (shutdown). Stored visitor is untouched. */
  reset(): void {
    this.#generation += 1;
    this.#grant = null;
    this.#inflight = null;
  }

  async #exchange(generation: number): Promise<SessionGrant> {
    const stored = this.#options.store.read();
    try {
      return await this.#post(stored, generation);
    } catch (error) {
      if (
        generation === this.#generation &&
        stored &&
        error instanceof MessengerError &&
        error.code === "visitor_proof_invalid"
      ) {
        // The stored secret no longer proves this visitor (revoked, or the
        // record was tampered with). Drop it and start over as a new visitor;
        // their previous conversations are unreachable from this browser.
        this.#options.store.clear();
        return this.#post(null, generation);
      }
      throw error;
    }
  }

  async #post(
    stored: {
      visitorId: string;
      secret: string;
      hasConversation: boolean;
    } | null,
    generation: number,
  ): Promise<SessionGrant> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const body: Record<string, unknown> = {
      publishableKey: this.#options.publishableKey,
    };
    if (stored) body.visitor = { id: stored.visitorId, secret: stored.secret };
    if (this.#options.locale) body.locale = this.#options.locale;

    let response: Response;
    let payload: unknown;
    try {
      response = await this.#fetch(
        `${this.#options.gatewayUrl}/v1/visitor-sessions`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        },
      );
      const text = await response.text();
      try {
        payload = text && text.length <= 65_536 ? JSON.parse(text) : undefined;
      } catch {
        payload = undefined;
      }
    } catch {
      // A CORS-blocked denial (origin not allowed) is indistinguishable from
      // a dropped connection here: the browser hides both.
      throw new MessengerError("network_error", { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const code =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>).error
          : undefined;
      if (
        typeof code === "string" &&
        KNOWN_CODES.has(code as MessengerErrorCode)
      ) {
        throw new MessengerError(code as MessengerErrorCode, {
          retryable: code === "temporarily_unavailable",
        });
      }
      throw new MessengerError(
        response.status >= 500 ? "temporarily_unavailable" : "invalid_request",
        { retryable: response.status >= 500 },
      );
    }

    const grant = this.#parse(payload, stored);
    // Shutdown({forget:true}) may clear persistent storage while this request
    // is in flight. A late response must never resurrect the forgotten proof.
    if (
      generation === this.#generation &&
      (!stored || stored.visitorId !== grant.visitorId)
    ) {
      const minted = readVisitor(payload);
      if (minted?.secret) {
        this.#options.store.write({
          visitorId: minted.id,
          secret: minted.secret,
          hasConversation: false,
        });
      }
    }
    return grant;
  }

  #parse(payload: unknown, stored: { visitorId: string } | null): SessionGrant {
    const data = record(record(payload)?.data);
    const token = data?.token;
    const visitor = readVisitor(payload);
    const inbox = record(data?.inbox);
    if (
      !data ||
      typeof token !== "string" ||
      !token ||
      token.length > MAX_TOKEN_LENGTH ||
      !visitor ||
      (!visitor.secret && stored?.visitorId !== visitor.id)
    ) {
      throw new MessengerError("temporarily_unavailable", { retryable: true });
    }
    // The session answer may only name a gateway on the same origin the site
    // configured; anything else is ignored, so a tampered response can never
    // send the visitor's token or messages somewhere else.
    const gatewayUrl = sameOriginGateway(
      data.gatewayUrl,
      this.#options.gatewayUrl,
    );
    return {
      token,
      expiresAt: parseExpiry(data.expiresAt, token, this.#now()),
      gatewayUrl,
      visitorId: visitor.id,
      inbox: {
        name: boundedText(inbox?.name, 80) ?? "Support",
        greeting: boundedText(inbox?.greeting, 280),
        accentColor:
          typeof inbox?.accentColor === "string" &&
          /^#[0-9a-fA-F]{6}$/.test(inbox.accentColor)
            ? inbox.accentColor.toLowerCase()
            : null,
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readVisitor(
  payload: unknown,
): { id: string; secret: string | null } | null {
  const visitor = record(record(record(payload)?.data)?.visitor);
  if (
    !visitor ||
    typeof visitor.id !== "string" ||
    !VISITOR_ID_PATTERN.test(visitor.id)
  )
    return null;
  const secret =
    typeof visitor.secret === "string" &&
    VISITOR_SECRET_PATTERN.test(visitor.secret)
      ? visitor.secret
      : null;
  return { id: visitor.id, secret };
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * `expiresAt` is accepted as an ISO-8601 string or epoch seconds/milliseconds.
 * When it is unusable, the token's own `exp` claim is used, and failing that a
 * conservative four minutes (tokens live five).
 */
export function parseExpiry(
  value: unknown,
  token: string,
  now: number,
): number {
  // Prefer the token's own lifetime (exp - iat) measured from our clock, so a
  // visitor whose clock is off by minutes neither refreshes on every call nor
  // keeps using a token the gateway already considers expired.
  const lifetime = jwtLifetime(token);
  if (Number.isFinite(lifetime) && lifetime > 0) return now + lifetime;
  let at = NaN;
  if (typeof value === "number") at = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string") at = Date.parse(value);
  if (!Number.isFinite(at)) at = jwtExpiry(token);
  if (!Number.isFinite(at) || at <= now) return now + FALLBACK_LIFETIME_MS;
  return at;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part || part.length > 8_192) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return record(JSON.parse(json));
  } catch {
    return null;
  }
}

function jwtExpiry(token: string): number {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : NaN;
}

function jwtLifetime(token: string): number {
  const claims = jwtClaims(token);
  const exp = claims?.exp;
  const iat = claims?.iat;
  if (typeof exp !== "number" || typeof iat !== "number") return NaN;
  // Bounded: never trust more than an hour, whatever the claims say.
  return Math.min((exp - iat) * 1000, 3_600_000);
}

/** `candidate` if it is an http(s) URL on `configured`'s origin, else `configured`. */
function sameOriginGateway(candidate: unknown, configured: string): string {
  if (typeof candidate !== "string" || !candidate || candidate.length > 2048)
    return configured;
  try {
    const url = new URL(candidate);
    const base = new URL(configured);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return configured;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return configured;
  }
}
