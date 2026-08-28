import { DaykeeperWebApiError, DaykeeperWebTransportError } from "./errors.js";
import type {
  DaykeeperClaimConversationResult,
  DaykeeperConversationList,
  DaykeeperConversationResult,
  DaykeeperCustomerIdentity,
  DaykeeperMessageList,
  DaykeeperMessageResult,
  DaykeeperSeenResult,
  DaykeeperUnreadSummary,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_MESSAGE_LENGTH = 16_000;

export interface DaykeeperWebTokenProviderContext {
  /** True only after the first access token was rejected with HTTP 401. */
  forceRefresh: boolean;
}

export type DaykeeperWebTokenProvider = (
  context: DaykeeperWebTokenProviderContext,
) => string | Promise<string>;

export interface DaykeeperWebClientOptions {
  baseUrl: string;
  getAccessToken: DaykeeperWebTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface DaykeeperWebRequestOptions {
  signal?: AbortSignal;
}

export class DaykeeperWebClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #getAccessToken: DaykeeperWebTokenProvider;
  readonly #timeoutMs: number;

  constructor(options: DaykeeperWebClientOptions) {
    this.#baseUrl = parseBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw configurationError("A Fetch API implementation is required");
    }
    if (typeof options.getAccessToken !== "function") {
      throw configurationError("getAccessToken must be a function");
    }
    this.#getAccessToken = options.getAccessToken;
    this.#timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  getIdentity(
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperCustomerIdentity> {
    return this.#request("/v1/identity", { signal: options?.signal });
  }

  listConversations(
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperConversationList> {
    return this.#request("/v1/conversations", { signal: options?.signal });
  }

  createConversation(
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperConversationResult> {
    return this.#request("/v1/conversations", {
      method: "POST",
      signal: options?.signal,
    });
  }

  getUnread(
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperUnreadSummary> {
    return this.#request("/v1/unread", { signal: options?.signal });
  }

  markConversationSeen(
    conversationId: number,
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperSeenResult> {
    return this.#request(
      `/v1/conversations/${positiveInteger(conversationId, "conversationId")}/seen`,
      { method: "POST", signal: options?.signal },
    );
  }

  listMessages(
    conversationId: number,
    options: DaykeeperWebRequestOptions & { after?: number } = {},
  ): Promise<DaykeeperMessageList> {
    const id = positiveInteger(conversationId, "conversationId");
    const after =
      options.after === undefined
        ? ""
        : `?after=${positiveInteger(options.after, "after")}`;
    return this.#request(`/v1/conversations/${id}/messages${after}`, {
      signal: options.signal,
    });
  }

  sendMessage(
    conversationId: number,
    content: string,
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperMessageResult> {
    const normalizedContent = validateMessage(content);
    return this.#request(
      `/v1/conversations/${positiveInteger(conversationId, "conversationId")}/messages`,
      {
        method: "POST",
        body: { content: normalizedContent },
        signal: options?.signal,
      },
    );
  }

  claimAnonymousConversation(
    widgetToken: string,
    options?: DaykeeperWebRequestOptions,
  ): Promise<DaykeeperClaimConversationResult> {
    if (
      typeof widgetToken !== "string" ||
      !widgetToken.trim() ||
      widgetToken.length > MAX_TOKEN_LENGTH
    ) {
      throw configurationError("widgetToken is invalid");
    }
    return this.#request("/v1/anonymous-conversations/claim", {
      method: "POST",
      body: { widgetToken: widgetToken.trim() },
      signal: options?.signal,
    });
  }

  async #request<ResponseBody>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<ResponseBody> {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, this.#timeoutMs);
    const onCallerAbort = () => timeoutController.abort();
    if (options.signal?.aborted) timeoutController.abort();
    else
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = validateToken(
          await this.#getAccessToken({ forceRefresh: attempt === 1 }),
        );
        const headers = new Headers({
          accept: "application/json",
          authorization: `Bearer ${token}`,
        });
        if (options.body !== undefined) {
          headers.set("content-type", "application/json");
        }

        let response: Response;
        try {
          response = await this.#fetch(`${this.#baseUrl}${path}`, {
            method: options.method ?? "GET",
            body:
              options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
            headers,
            signal: timeoutController.signal,
          });
        } catch {
          if (timedOut) {
            throw new DaykeeperWebTransportError({
              code: "REQUEST_TIMEOUT",
              message: `The Daykeeper request exceeded ${this.#timeoutMs}ms`,
              retryable: true,
            });
          }
          if (options.signal?.aborted) {
            throw new DaykeeperWebTransportError({
              code: "REQUEST_ABORTED",
              message: "The Daykeeper request was aborted",
            });
          }
          throw new DaykeeperWebTransportError({
            code: "NETWORK_ERROR",
            message: "The Daykeeper customer API could not be reached",
            retryable: true,
          });
        }

        const payload = await readJson(response);
        if (response.status === 401 && attempt === 0) continue;
        if (!response.ok) {
          const code =
            isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : "daykeeper_request_failed";
          throw new DaykeeperWebApiError({
            status: response.status,
            code,
            retryable:
              response.status === 408 ||
              response.status === 429 ||
              response.status >= 500,
          });
        }
        if (!isRecord(payload)) {
          throw new DaykeeperWebTransportError({
            code: "INVALID_RESPONSE",
            message: "The Daykeeper customer API returned an invalid response",
            retryable: true,
          });
        }
        return payload as ResponseBody;
      }
      throw new Error("Unreachable Daykeeper request state");
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function createDaykeeperWebClient(
  options: DaykeeperWebClientOptions,
): DaykeeperWebClient {
  return new DaykeeperWebClient(options);
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("baseUrl must be a valid absolute URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw configurationError(
      "baseUrl must use HTTPS except for loopback development",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError(
      "baseUrl cannot include credentials, a query, or a fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw configurationError(
      "timeoutMs must be an integer from 1000 through 60000",
    );
  }
  return value;
}

function validateToken(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_TOKEN_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    throw configurationError("The customer access token is invalid");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw configurationError(`${name} must be a positive integer`);
  }
  return value;
}

function validateMessage(value: string): string {
  if (typeof value !== "string") {
    throw configurationError("Message content must be a string");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_MESSAGE_LENGTH) {
    throw configurationError(
      `Message content must be 1 to ${MAX_MESSAGE_LENGTH} characters`,
    );
  }
  return normalized;
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw responseTooLarge();
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DaykeeperWebTransportError({
      code: "INVALID_RESPONSE",
      message: "The Daykeeper customer API returned invalid JSON",
      retryable: true,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseTooLarge(): DaykeeperWebTransportError {
  return new DaykeeperWebTransportError({
    code: "RESPONSE_TOO_LARGE",
    message: "The Daykeeper response exceeded 1 MiB",
  });
}

function configurationError(message: string): DaykeeperWebTransportError {
  return new DaykeeperWebTransportError({
    code: "INVALID_CONFIGURATION",
    message,
  });
}
