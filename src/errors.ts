export type DaykeeperWebTransportErrorCode =
  | "INVALID_CONFIGURATION"
  | "NETWORK_ERROR"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE";

export class DaykeeperWebApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: { status: number; code: string; retryable: boolean }) {
    super(options.code);
    this.name = "DaykeeperWebApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }

  toJSON(): {
    name: string;
    status: number;
    code: string;
    retryable: boolean;
  } {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      retryable: this.retryable,
    };
  }
}

export class DaykeeperWebTransportError extends Error {
  readonly code: DaykeeperWebTransportErrorCode;
  readonly retryable: boolean;

  constructor(options: {
    code: DaykeeperWebTransportErrorCode;
    message: string;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "DaykeeperWebTransportError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): {
    name: string;
    code: DaykeeperWebTransportErrorCode;
    message: string;
    retryable: boolean;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}
