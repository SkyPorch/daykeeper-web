import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import {
  DaykeeperWebClient,
  DaykeeperWebTransportError as TransportError,
  type DaykeeperWebTokenProviderContext as TokenContext,
} from "../src/index.ts";

test("pre-aborted requests do not invoke credentials or transport", async () => {
  const caller = new AbortController();
  caller.abort(new Error("private abort reason"));
  let tokenCalls = 0;
  let fetchCalls = 0;
  const request = makeRequest({
    token: () => {
      tokenCalls++;
      return "token";
    },
    fetch: async () => {
      fetchCalls++;
      return success();
    },
  });
  await rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("the deadline includes stalled credentials and prevents late dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const credential = deferred<string>();
  const started = deferred<void>();
  let providerSignal: AbortSignal | undefined;
  let fetchCalls = 0;
  const request = makeRequest({
    timeoutMs: 1000,
    token: (context) => {
      providerSignal = context?.signal;
      started.resolve();
      return credential.promise;
    },
    fetch: async () => {
      fetchCalls++;
      return success();
    },
  });
  const rejected = rejectsCode(request(), "REQUEST_TIMEOUT");
  await started.promise;
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(providerSignal?.aborted, true);
  credential.resolve("late-token");
  await nextTurn();
  assert.equal(fetchCalls, 0);
});

test("an overdue credential cannot dispatch before the timer gets CPU time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  let fetchCalls = 0;
  const request = makeRequest({
    timeoutMs: 1000,
    token: () => {
      elapsed = 1001;
      return "late-token";
    },
    fetch: async () => {
      fetchCalls++;
      return success();
    },
  });
  await rejectsCode(request(), "REQUEST_TIMEOUT");
  assert.equal(fetchCalls, 0);
});

test("caller cancellation settles a stalled credential provider", async () => {
  const caller = new AbortController();
  const credential = deferred<string>();
  const started = deferred<void>();
  let fetchCalls = 0;
  const request = makeRequest({
    token: () => {
      started.resolve();
      return credential.promise;
    },
    fetch: async () => {
      fetchCalls++;
      return success();
    },
  });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await started.promise;
  caller.abort("private abort reason");
  await rejected;
  credential.resolve("late-token");
  await nextTurn();
  assert.equal(fetchCalls, 0);
});

test("an overdue provider rejection cannot override the original deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const request = makeRequest({
    timeoutMs: 1000,
    token: () => {
      elapsed = 1001;
      throw new Error("private provider failure after deadline");
    },
  });
  await rejectsCode(request(), "REQUEST_TIMEOUT");
});

test("a transport that ignores abort cannot outlive the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = deferred<Response>();
  const started = deferred<void>();
  let transportSignal: AbortSignal | undefined;
  let discarded = false;
  const request = makeRequest({
    timeoutMs: 1000,
    fetch: async (_url, init) => {
      transportSignal = init?.signal ?? undefined;
      started.resolve();
      return transport.promise;
    },
  });
  const rejected = rejectsCode(request(), "REQUEST_TIMEOUT");
  await started.promise;
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(transportSignal?.aborted, true);
  transport.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          discarded = true;
        },
      }),
    ),
  );
  await nextTurn();
  assert.equal(discarded, true, "a late response body must be released");
});

test("late transport rejection remains handled after caller cancellation", async () => {
  const caller = new AbortController();
  const transport = deferred<Response>();
  const started = deferred<void>();
  const request = makeRequest({
    fetch: async () => {
      started.resolve();
      return transport.promise;
    },
  });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await started.promise;
  caller.abort();
  await rejected;
  transport.reject(new Error("private late network error"));
  await nextTurn();
});

test("a stalled body is cancelled without waiting for its cleanup promise", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let discarded = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      discarded = true;
      return new Promise<void>(() => {});
    },
  });
  const request = makeRequest({
    timeoutMs: 1000,
    fetch: async () => new Response(body),
  });
  const rejected = rejectsCode(request(), "REQUEST_TIMEOUT");
  await nextTurn();
  assert.equal(body.locked, true);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(discarded, true);
  assert.equal(body.locked, false);
});

test("throwing stream cleanup cannot replace timeout or cancellation", async (t) => {
  for (const code of ["REQUEST_TIMEOUT", "REQUEST_ABORTED"]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const caller = new AbortController();
    const body = new ReadableStream<Uint8Array>();
    const response = new Response(body);
    const reader = body.getReader();
    const cancel = reader.cancel.bind(reader);
    const release = reader.releaseLock.bind(reader);
    t.mock.method(body, "getReader", () => reader);
    t.mock.method(reader, "cancel", () => {
      throw new Error("private cancel failure");
    });
    t.mock.method(reader, "releaseLock", () => {
      throw new Error("private release failure");
    });
    const request = makeRequest({
      timeoutMs: 1000,
      fetch: async () => response,
    });
    const rejected = rejectsCode(request(caller.signal), code);
    await nextTurn();
    if (code === "REQUEST_TIMEOUT") t.mock.timers.tick(1000);
    else caller.abort();
    await rejected;
    await cancel();
    release();
    t.mock.timers.reset();
  }
});

test("caller abort during body reading remains REQUEST_ABORTED", async () => {
  const caller = new AbortController();
  let discarded = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      discarded = true;
    },
  });
  const request = makeRequest({ fetch: async () => new Response(body) });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await nextTurn();
  caller.abort(new Error("private reason"));
  await rejected;
  assert.equal(discarded, true);
  assert.equal(body.locked, false);
});

test("authentication refresh shares the original deadline and abort signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = deferred<Response>();
  const fetchStarted = deferred<void>();
  const refreshStarted = deferred<void>();
  const signals: Array<AbortSignal | undefined> = [];
  const refresh: boolean[] = [];
  let fetchCalls = 0;
  const request = makeRequest({
    timeoutMs: 1000,
    token: (context) => {
      signals.push(context?.signal);
      refresh.push(context?.forceRefresh ?? false);
      if (context?.forceRefresh) {
        refreshStarted.resolve();
        return new Promise<string>(() => {});
      }
      return "stale-token";
    },
    fetch: async () => {
      fetchCalls++;
      fetchStarted.resolve();
      return response.promise;
    },
  });
  const rejected = rejectsCode(request(), "REQUEST_TIMEOUT");
  await fetchStarted.promise;
  t.mock.timers.tick(600);
  response.resolve(new Response("not JSON", { status: 401 }));
  await refreshStarted.promise;
  t.mock.timers.tick(400);
  await rejected;
  assert.deepEqual(refresh, [false, true]);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(fetchCalls, 1);
});

test("a 401 body cannot block the one permitted authentication refresh", async () => {
  let discarded = false;
  let fetchCalls = 0;
  const refresh: boolean[] = [];
  const request = makeRequest({
    token: (context) => {
      refresh.push(context?.forceRefresh ?? false);
      return "token";
    },
    fetch: async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(
          new ReadableStream({
            cancel() {
              discarded = true;
              return new Promise<void>(() => {});
            },
          }),
          { status: 401 },
        );
      }
      return success();
    },
  });
  await request();
  assert.equal(discarded, true);
  assert.deepEqual(refresh, [false, true]);
  assert.equal(fetchCalls, 2);
});

test("oversized bodies fail without waiting for cancellation", async () => {
  for (const declared of [true, false]) {
    let discarded = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        discarded = true;
        return new Promise<void>(() => {});
      },
    });
    const request = makeRequest({
      fetch: async () =>
        new Response(body, {
          headers: declared
            ? { "content-length": String(1024 * 1024 + 1) }
            : {},
        }),
    });
    await rejectsCode(request(), "RESPONSE_TOO_LARGE");
    assert.equal(discarded, true);
    assert.equal(body.locked, false);
  }
});

test("credential failures cannot leak arbitrary provider errors", async () => {
  const request = makeRequest({
    token: () => {
      throw new Error("private provider credential");
    },
  });
  await rejectsCode(request(), "TOKEN_PROVIDER_ERROR");
});

test("asynchronous credential rejection is non-retryable and redacted", async () => {
  const request = makeRequest({
    token: async () => {
      throw new Error("private authentication failure");
    },
  });
  await rejectsCode(request(), "TOKEN_PROVIDER_ERROR");
});

test("a cooperative credential provider preserves cancellation classification", async (t) => {
  for (const timeout of [false, true]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const caller = new AbortController();
    const started = deferred<void>();
    const request = makeRequest({
      timeoutMs: 1000,
      token: (context) =>
        new Promise<string>((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private provider abort")),
            { once: true },
          );
          started.resolve();
        }),
    });
    const rejected = rejectsCode(
      request(caller.signal),
      timeout ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
    );
    await started.promise;
    if (timeout) t.mock.timers.tick(1000);
    else caller.abort();
    await rejected;
    t.mock.timers.reset();
  }
});

test("caller cancellation during refresh cannot dispatch again", async () => {
  const caller = new AbortController();
  const refreshing = deferred<void>();
  let fetchCalls = 0;
  const request = makeRequest({
    token: (context) => {
      if (context?.forceRefresh) {
        refreshing.resolve();
        return new Promise<string>(() => {});
      }
      return "stale-token";
    },
    fetch: async () => {
      fetchCalls++;
      return new Response(null, { status: 401 });
    },
  });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await refreshing.promise;
  caller.abort();
  await rejected;
  assert.equal(fetchCalls, 1);
});

test("late authentication rejection is discarded without refreshing", async () => {
  const caller = new AbortController();
  const transport = deferred<Response>();
  const started = deferred<void>();
  let tokenCalls = 0;
  let discarded = false;
  const request = makeRequest({
    token: () => {
      tokenCalls++;
      return "token";
    },
    fetch: async () => {
      started.resolve();
      return transport.promise;
    },
  });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await started.promise;
  caller.abort();
  await rejected;
  transport.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          discarded = true;
        },
      }),
      { status: 401 },
    ),
  );
  await nextTurn();
  assert.equal(discarded, true);
  assert.equal(tokenCalls, 1);
});

test("an errored response stream releases its reader and hides raw errors", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const request = makeRequest({ fetch: async () => new Response(body) });
  const rejected = rejectsCode(request(), "NETWORK_ERROR");
  await nextTurn();
  streamController.error(new Error("private network failure"));
  await rejected;
  assert.equal(body.locked, false);
});

test("network failure is not automatically replayed", async () => {
  let fetchCalls = 0;
  const request = makeRequest({
    fetch: async () => {
      fetchCalls++;
      throw new Error("private request details");
    },
  });
  await rejectsCode(request(), "NETWORK_ERROR");
  assert.equal(fetchCalls, 1);
});

test("settled requests remove caller listeners and clear the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  const added = t.mock.method(caller.signal, "addEventListener");
  const removed = t.mock.method(caller.signal, "removeEventListener");
  let providerSignal: AbortSignal | undefined;
  const request = makeRequest({
    token: (context) => {
      providerSignal = context?.signal;
      return "token";
    },
  });
  await request(caller.signal);
  assert.equal(added.mock.callCount(), 1);
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(
    added.mock.calls[0]?.arguments[1],
    removed.mock.calls[0]?.arguments[1],
  );
  t.mock.timers.tick(60_000);
  caller.abort();
  assert.equal(providerSignal?.aborted, false);
});

test("concurrent requests have independent cancellation", async () => {
  const caller = new AbortController();
  const waiting = deferred<void>();
  let fetchCalls = 0;
  const request = makeRequest({
    fetch: async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        waiting.resolve();
        return new Promise<Response>(() => {});
      }
      return success();
    },
  });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await waiting.promise;
  await request();
  caller.abort();
  await rejected;
  assert.equal(fetchCalls, 2);
});

test(
  "real HTTP body stalls time out after headers are received",
  { timeout: 5000 },
  async (t) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const request = makeRequest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 1000,
      fetch,
    });
    await rejectsCode(request(), "REQUEST_TIMEOUT");
    assert.equal(requests, 1);
  },
);

test("buffered Fetch body reads share the request deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred<void>();
  const request = makeRequest({
    timeoutMs: 1000,
    fetch: async () =>
      ({
        body: undefined,
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () => {
          started.resolve();
          return new Promise<string>(() => {});
        },
      }) as unknown as Response,
  });
  const rejected = rejectsCode(request(), "REQUEST_TIMEOUT");
  await started.promise;
  t.mock.timers.tick(1000);
  await rejected;
});

test("buffered Fetch reads preserve caller cancellation errors", async () => {
  const caller = new AbortController();
  const started = deferred<void>();
  const request = makeRequest({
    fetch: async () =>
      ({
        body: undefined,
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () => {
          started.resolve();
          return new Promise<string>(() => {});
        },
      }) as unknown as Response,
  });
  const rejected = rejectsCode(request(caller.signal), "REQUEST_ABORTED");
  await started.promise;
  caller.abort();
  await rejected;
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rejectsCode(request: Promise<unknown>, code: string) {
  return assert.rejects(request, (error: unknown) => {
    assert(error instanceof TransportError);
    assert.equal(error.code, code);
    assert.equal(
      error.retryable,
      code === "REQUEST_TIMEOUT" || code === "NETWORK_ERROR",
    );
    assert(!JSON.stringify(error).includes("private"));
    return true;
  });
}

function success() {
  return Response.json({ unreadCount: 0 });
}

function makeRequest(
  options: {
    baseUrl?: string;
    token?: (context?: TokenContext) => string | Promise<string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  const client = new DaykeeperWebClient({
    baseUrl: options.baseUrl ?? "https://support.daykeeper.example",
    getAccessToken: options.token ?? (() => "token"),
    fetch: options.fetch ?? (async () => success()),
    timeoutMs: options.timeoutMs,
  });
  return (signal?: AbortSignal) => client.getUnread({ signal });
}
