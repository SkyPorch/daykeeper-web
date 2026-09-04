import { DaykeeperWebApiError, DaykeeperWebTransportError } from "./errors.js";
import {
  createRequestLifetime,
  discardResponse,
  discardReader,
} from "./requestLifetime.js";
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
  /**
   * True only after a GET rejected the first token with HTTP 401. The
   * provider should bypass any token cache and exchange the app session again.
   */
  forceRefresh: boolean;
  /** Cancel credential exchange when the request is aborted or expires. */
  signal: AbortSignal;
}

export type DaykeeperWebTokenProvider = (
  context: DaykeeperWebTokenProviderContext,
) => string | Promise<string>;

export interface DaykeeperWebClientOptions {
  /** Trusted tenant gateway origin and optional path prefix. */
  baseUrl: string;
  /** Obtain a short-lived, customer-scoped token from your own backend. */
  getAccessToken: DaykeeperWebTokenProvider;
  /** Advanced transport injection; it must preserve standard Fetch security. */
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
    if (!options || typeof options !== "object") {
      throw configurationError("Client options are required");
    }
    if (
      typeof URL !== "function" ||
      typeof Headers !== "function" ||
      typeof AbortController !== "function" ||
      typeof TextDecoder !== "function"
    ) {
      throw configurationError("Standard browser Fetch globals are required");
    }
    this.#baseUrl = parseBaseUrl(options.baseUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw configurationError("A Fetch API implementation is required");
    }
    this.#fetch = fetchImpl.bind(globalThis);
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
    const lifetime = createRequestLifetime(this.#timeoutMs, options.signal);
    const method = options.method ?? "GET";
    const mutating = method !== "GET";
    const attempts = mutating ? 1 : 2;
    const requestUrl = `${this.#baseUrl}${path}`;
    let dispatched = false;
    let response: Response | undefined;

    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const token = validateToken(
          await lifetime.run(() =>
            resolveToken(this.#getAccessToken, {
              forceRefresh: attempt === 1,
              signal: lifetime.signal,
            }),
          ),
        );
        const headers = new Headers({
          accept: "application/json",
          authorization: `Bearer ${token}`,
        });
        if (options.body !== undefined) {
          headers.set("content-type", "application/json");
        }

        try {
          response = await lifetime.run(() => {
            dispatched = true;
            return this.#fetch(requestUrl, {
              method,
              body:
                options.body === undefined
                  ? undefined
                  : JSON.stringify(options.body),
              headers,
              signal: lifetime.signal,
              credentials: "omit",
              mode: "cors",
              redirect: "error",
              cache: "no-store",
              referrerPolicy: "no-referrer",
            });
          }, discardResponse);
        } catch (error) {
          if (error instanceof DaykeeperWebTransportError) throw error;
          throw networkError();
        }

        assertResponseEndpoint(response, requestUrl);
        let payload: unknown;
        if (!mutating && response.status === 401 && attempt === 0) {
          // A managed denial may explicitly forbid replay, including an auth
          // refresh. Read it within the same size/deadline/cancellation bounds.
          try {
            payload = await readJson(response, lifetime);
          } catch (error) {
            // Complete legacy non-JSON 401 responses carry no structured hint.
            // A stalled/oversized/cancelled response is not permission to retry.
            if (
              !(error instanceof DaykeeperWebTransportError) ||
              error.code !== "INVALID_RESPONSE"
            )
              throw error;
          }
          if (!(isRecord(payload) && payload.retryable === false)) {
            discardResponse(response);
            continue;
          }
        } else {
          payload = await readJson(response, lifetime);
        }
        if (!response.ok) {
          throw new DaykeeperWebApiError({
            status: response.status,
            code: isRecord(payload) ? payload.error : undefined,
            retryable:
              !mutating &&
              (isRecord(payload) && typeof payload.retryable === "boolean"
                ? payload.retryable
                : response.status === 408 ||
                  response.status === 429 ||
                  response.status >= 500),
            outcomeUnknown:
              mutating && (response.status === 408 || response.status >= 500),
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
    } catch (error) {
      if (error instanceof DaykeeperWebApiError) throw error;
      const safeError =
        error instanceof DaykeeperWebTransportError ? error : networkError();
      if (!mutating) throw safeError;
      throw new DaykeeperWebTransportError({
        code: safeError.code,
        message: safeError.message,
        retryable: false,
        outcomeUnknown: dispatched,
      });
    } finally {
      if (response) discardResponse(response);
      lifetime.dispose();
    }
  }
}

export function createDaykeeperWebClient(
  options: DaykeeperWebClientOptions,
): DaykeeperWebClient {
  return new DaykeeperWebClient(options);
}

async function resolveToken(
  provider: DaykeeperWebTokenProvider,
  context: DaykeeperWebTokenProviderContext,
): Promise<string> {
  try {
    return await provider(context);
  } catch {
    throw new DaykeeperWebTransportError({
      code: "TOKEN_PROVIDER_ERROR",
      message: "The Daykeeper access token could not be obtained",
    });
  }
}

function networkError(): DaykeeperWebTransportError {
  return new DaykeeperWebTransportError({
    code: "NETWORK_ERROR",
    message: "The Daykeeper customer API transport failed",
    retryable: true,
  });
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    if (typeof value !== "string" || !value.trim()) throw new Error();
    url = new URL(value);
  } catch {
    throw configurationError("baseUrl must be a valid absolute URL");
  }
  // URL canonicalization resolves alternate IPv4 spellings. The IPv6
  // hostname retains brackets; private/LAN and emulator host aliases are not
  // loopback. No DNS-based hostname suffix or string-prefix allowlist is used.
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw configurationError(
      "baseUrl must use HTTPS except for loopback development",
    );
  }
  if (
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw configurationError(
      "baseUrl cannot include credentials, a query, or a fragment",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function assertResponseEndpoint(response: Response, requestUrl: string): void {
  if (
    response.redirected ||
    response.type === "opaque" ||
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400) ||
    (response.url && response.url !== requestUrl)
  ) {
    throw new DaykeeperWebTransportError({
      code: "REDIRECT_REJECTED",
      message: "The Daykeeper transport did not return a direct API response",
    });
  }
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
    !/^[A-Za-z0-9._~+\/-]+=*$/.test(value)
  ) {
    throw configurationError("The customer access token is invalid");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw configurationError(`${name} must be a positive safe integer`);
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

async function readJson(
  response: Response,
  lifetime: ReturnType<typeof createRequestLifetime>,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw responseTooLarge();
  }

  const body = response.body;
  if (
    body &&
    typeof body.getReader === "function" &&
    typeof TextDecoder === "function"
  ) {
    return parseJson(await readStream(body, lifetime));
  }

  let text: string;
  try {
    text = await lifetime.run(() => response.text());
  } catch (error) {
    if (error instanceof DaykeeperWebTransportError) throw error;
    throw invalidResponse();
  }
  if (utf8LengthExceeds(text, MAX_RESPONSE_BYTES)) {
    throw responseTooLarge();
  }
  return parseJson(text);
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  lifetime: ReturnType<typeof createRequestLifetime>,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lifetime.run(() => reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DaykeeperWebTransportError) throw error;
    throw networkError();
  } finally {
    discardReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse();
  }
}

function utf8LengthExceeds(value: string, maximum: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maximum) return true;
  }
  return false;
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

function invalidResponse(): DaykeeperWebTransportError {
  return new DaykeeperWebTransportError({
    code: "INVALID_RESPONSE",
    message: "The Daykeeper customer API returned invalid JSON",
    retryable: true,
  });
}

function configurationError(message: string): DaykeeperWebTransportError {
  return new DaykeeperWebTransportError({
    code: "INVALID_CONFIGURATION",
    message,
  });
}
