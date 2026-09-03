export type DaykeeperWebTransportErrorCode =
  | "INVALID_CONFIGURATION"
  | "TOKEN_PROVIDER_ERROR"
  | "NETWORK_ERROR"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_REJECTED";

// Error bodies are untrusted, so a code is only allowed through when its
// *shape* proves it is a code and not prose, a token, or an identifier: ASCII
// lowercase snake_case, 3 to 64 characters. The gateway's error vocabulary is
// open and grows without an SDK release, so an allowlist would silently
// collapse codes that consuming apps switch on. A bounded snake_case token is
// not a redaction channel of consequence; anything failing the shape -- English
// prose, mixed case, punctuation, whitespace, non-string values -- becomes the
// generic code below. The contract's `message` is still never read, and the
// error message remains the code itself.
const API_CODE_SHAPE = /^[a-z][a-z0-9_]{2,63}$/;

export const DAYKEEPER_GENERIC_API_CODE = "daykeeper_request_failed";

/** True when `value` has the documented customer API error-code shape. */
export function isDaykeeperApiErrorCode(value: unknown): value is string {
  return typeof value === "string" && API_CODE_SHAPE.test(value);
}

/**
 * Contract-documented next steps. The envelope is open and its values are
 * extensible, so an unrecognized hint is dropped rather than surfaced: a
 * gateway string is untrusted and none of these grant account authority.
 */
export type DaykeeperWebNextAction =
  "review_usage" | "review_setup" | "refresh_conversation";

const SAFE_NEXT_ACTIONS = new Set<string>([
  "review_usage",
  "review_setup",
  "refresh_conversation",
]);

export class DaykeeperWebApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly nextAction?: DaykeeperWebNextAction;

  constructor(options: {
    status: number;
    code?: unknown;
    nextAction?: unknown;
    retryable?: boolean;
    outcomeUnknown?: boolean;
  }) {
    const code = isDaykeeperApiErrorCode(options.code)
      ? options.code
      : DAYKEEPER_GENERIC_API_CODE;
    super(code);
    this.name = "DaykeeperWebApiError";
    this.status = options.status;
    this.code = code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.retryable = !this.outcomeUnknown && (options.retryable ?? false);
    if (
      typeof options.nextAction === "string" &&
      SAFE_NEXT_ACTIONS.has(options.nextAction)
    ) {
      this.nextAction = options.nextAction as DaykeeperWebNextAction;
    }
  }

  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
      ...(this.nextAction === undefined ? {} : { nextAction: this.nextAction }),
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
