import { DaykeeperWebTransportError } from "./errors.js";

// One budget covers credentials, both authentication attempts, and the body.
// Aborting fetch alone cannot bound a provider or custom transport that stalls.
export function createRequestLifetime(timeoutMs: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const now = () =>
    typeof performance === "undefined" ? Date.now() : performance.now();
  const deadline = now() + timeoutMs;
  let failure: DaykeeperWebTransportError | undefined;
  const abort = (code: "REQUEST_ABORTED" | "REQUEST_TIMEOUT") => {
    if (failure) return;
    failure = new DaykeeperWebTransportError({
      code,
      message:
        code === "REQUEST_TIMEOUT"
          ? `The Daykeeper request exceeded ${timeoutMs}ms`
          : "The Daykeeper request was aborted",
      retryable: code === "REQUEST_TIMEOUT",
    });
    controller.abort();
  };
  const onCallerAbort = () => abort("REQUEST_ABORTED");
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });
  const timeout = failure
    ? undefined
    : setTimeout(() => abort("REQUEST_TIMEOUT"), timeoutMs);
  const checkDeadline = () => {
    if (!failure && now() >= deadline) abort("REQUEST_TIMEOUT");
  };

  return {
    signal: controller.signal,
    run<T>(
      work: () => T | PromiseLike<T>,
      onLateValue?: (value: T) => void,
    ): Promise<T> {
      checkDeadline();
      if (failure) return Promise.reject(failure);
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          finish();
          reject(failure);
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => {
            // Do not start work queued before an abort, or send with a late token.
            checkDeadline();
            if (failure) throw failure;
            return work();
          })
          .then(
            (value) => {
              checkDeadline();
              if (settled) {
                try {
                  onLateValue?.(value);
                } catch {
                  // Late cleanup must not cause an unhandled rejection.
                }
                return;
              }
              finish();
              resolve(value);
            },
            (error: unknown) => {
              checkDeadline();
              if (settled) return;
              finish();
              reject(error);
            },
          );
      });
    },
    dispose() {
      clearTimeout(timeout);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

// Cleanup must not delay timeout/error delivery, including with custom streams.
export function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A consumed/locked or non-streaming body may not support cancellation.
  }
}

export function discardReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // A failed transport may already have released the reader.
  }
  try {
    reader.releaseLock();
  } catch {
    // Some stream polyfills cannot release a pending read. Preserve the
    // original timeout/abort/error even when their cleanup is unsupported.
  }
}
