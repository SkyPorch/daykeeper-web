export type DaykeeperWebTransportErrorCode =
  | "INVALID_CONFIGURATION"
  | "TOKEN_PROVIDER_ERROR"
  | "NETWORK_ERROR"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_REJECTED";

// Gateway bodies are untrusted. A syntactically valid string can still contain
// a token, customer identifier, or message, so a regex is not a redaction policy.
const SAFE_API_CODES = new Set([
  "missing_bearer_token",
  "invalid_bearer_token",
  "invalid_token",
  "unsupported_token",
  "invalid_signature",
  "invalid_tenant",
  "unknown_tenant",
  "invalid_issuer",
  "invalid_audience",
  "invalid_subject",
  "invalid_expiration",
  "expired_token",
  "token_lifetime_too_long",
  "insufficient_scope",
  "not_found",
  "support_upstream_rejected",
  "support_upstream_unavailable",
]);

export class DaykeeperWebApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(options: {
    status: number;
    code?: unknown;
    retryable?: boolean;
    outcomeUnknown?: boolean;
  }) {
    const code =
      typeof options.code === "string" && SAFE_API_CODES.has(options.code)
        ? options.code
        : "daykeeper_request_failed";
    super(code);
    this.name = "DaykeeperWebApiError";
    this.status = options.status;
    this.code = code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.retryable = !this.outcomeUnknown && (options.retryable ?? false);
  }

  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
    };
  }
}

export class DaykeeperWebTransportError extends Error {
  readonly code: DaykeeperWebTransportErrorCode;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(options: {
    code: DaykeeperWebTransportErrorCode;
    message: string;
    retryable?: boolean;
    outcomeUnknown?: boolean;
  }) {
    super(options.message);
    this.name = "DaykeeperWebTransportError";
    this.code = options.code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.retryable = !this.outcomeUnknown && (options.retryable ?? false);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
    };
  }
}
