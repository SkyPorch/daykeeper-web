import {
  DaykeeperWebApiError,
  DaykeeperWebTransportError,
} from "../../src/index.ts";

/**
 * Codes the visitor-session exchange and the gateway return to a visitor
 * (SPEC §3/§4), plus `network_error` for failures the browser hides from us —
 * including CORS-blocked denials, which look exactly like a dropped network.
 */
export type MessengerErrorCode =
  | "invalid_request"
  | "origin_not_allowed"
  | "web_client_unavailable"
  | "visitor_proof_invalid"
  | "temporarily_unavailable"
  | "web_client_disabled"
  | "visitor_not_allowed"
  | "content_too_long"
  | "network_error"
  | "usage_limited"
  | "unknown";

export class MessengerError extends Error {
  readonly code: MessengerErrorCode;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly authFailure: boolean;

  constructor(
    code: MessengerErrorCode,
    options: {
      retryable?: boolean;
      outcomeUnknown?: boolean;
      authFailure?: boolean;
    } = {},
  ) {
    super(code);
    this.name = "MessengerError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.authFailure = options.authFailure ?? false;
  }
}

const USAGE_CODES = new Set([
  "daykeeper_usage_limit_exceeded",
  "daykeeper_usage_not_enabled",
  "daykeeper_support_not_ready",
]);

const AUTH_CODES = new Set([
  "invalid_token",
  "expired_token",
  "invalid_signature",
  "missing_bearer_token",
  "invalid_bearer_token",
  "unsupported_token",
]);

const PASSTHROUGH = new Set<MessengerErrorCode>([
  "invalid_request",
  "origin_not_allowed",
  "web_client_unavailable",
  "visitor_proof_invalid",
  "temporarily_unavailable",
  "web_client_disabled",
  "visitor_not_allowed",
  "content_too_long",
]);

/** Map anything thrown by the session exchange or the web SDK to one code. */
export function toMessengerError(error: unknown): MessengerError {
  if (error instanceof MessengerError) return error;
  if (error instanceof DaykeeperWebApiError) {
    const code = error.code;
    if (PASSTHROUGH.has(code as MessengerErrorCode)) {
      return new MessengerError(code as MessengerErrorCode, {
        retryable: code === "temporarily_unavailable",
      });
    }
    if (USAGE_CODES.has(code)) return new MessengerError("usage_limited");
    if (error.status === 401 || AUTH_CODES.has(code)) {
      return new MessengerError("unknown", {
        authFailure: true,
        outcomeUnknown: error.outcomeUnknown,
      });
    }
    if (error.status >= 500 || error.status === 408 || error.status === 429) {
      return new MessengerError("temporarily_unavailable", {
        retryable: true,
        outcomeUnknown: error.outcomeUnknown,
      });
    }
    return new MessengerError("unknown", {
      outcomeUnknown: error.outcomeUnknown,
    });
  }
  if (error instanceof DaykeeperWebTransportError) {
    if (error.code === "REQUEST_ABORTED") {
      return new MessengerError("unknown", {
        outcomeUnknown: error.outcomeUnknown,
      });
    }
    return new MessengerError("network_error", {
      retryable: true,
      outcomeUnknown: error.outcomeUnknown,
    });
  }
  return new MessengerError("unknown");
}

/** Errors that end the session for this page: no polling, no auto-retry. */
export function isTerminal(code: MessengerErrorCode): boolean {
  return (
    code === "web_client_unavailable" ||
    code === "web_client_disabled" ||
    code === "origin_not_allowed"
  );
}
