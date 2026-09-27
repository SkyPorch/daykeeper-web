import assert from "node:assert/strict";
import test from "node:test";
import {
  DaykeeperWebApiError,
  DaykeeperWebTransportError,
  type DaykeeperConversation,
  type DaykeeperMessage,
} from "../../../src/index.ts";
import {
  authorOf,
  mergeServerMessages,
  MessengerController,
  POLL,
  settleUnconfirmed,
  type ControllerEvent,
  type ThreadMessage,
} from "../../src/controller.ts";
import { MessengerError } from "../../src/errors.ts";
import type { SessionGrant, VisitorSession } from "../../src/session.ts";
import { createVisitorStore } from "../../src/storage.ts";

const VISITOR = {
  visitorId: "v_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  secret: "a".repeat(43),
};

// ---- virtual clock + timers ---------------------------------------------

function createClock() {
  let now = 1_800_000_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  };
  return {
    get now() {
      return now;
    },
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    /** Delay of the single pending timer, or -1. */
    pending(): number {
      const next = [...timers.values()].sort((a, b) => a.at - b.at)[0];
      return next ? next.at - now : -1;
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
    flush,
    tick(ms: number) {
      now += ms;
    },
  };
}

// ---- fakes ----------------------------------------------------------------

function conversation(
  id: number,
  extra: Partial<DaykeeperConversation> = {},
): DaykeeperConversation {
  return {
    id,
    status: "open",
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    unreadCount: 0,
    unreadForContact: 0,
    lastSeenAt: null,
    preview: null,
    ...extra,
  };
}

function message(
  id: number,
  author: "customer" | "agent" | "human" | "system",
  content = `m${id}`,
): DaykeeperMessage & { author: string } {
  return {
    id,
    conversationId: 7,
    content,
    contentType: "text",
    contentAttributes: {},
    messageType: author === "customer" ? 0 : 1,
    createdAt: 1_800_000_000,
    sender:
      author === "customer"
        ? null
        : { name: author === "agent" ? "Fern" : "Maya", avatarUrl: null },
    attachments: [],
    author,
  };
}

type Method =
  | "listConversations"
  | "createConversation"
  | "listMessages"
  | "sendMessage"
  | "getUnread"
  | "markConversationSeen";

function setup(options: { stored?: boolean; hasConversation?: boolean } = {}) {
  const clock = createClock();
  let visible = true;
  const store = createVisitorStore(
    "dk_pk_Test0000000000000000000000000001",
    () => null,
  );
  if (options.stored ?? true) {
    store.write({
      ...VISITOR,
      hasConversation: options.hasConversation ?? false,
    });
  }
  const sessionCalls: boolean[] = [];
  let sessionFailure: unknown = null;
  const grant: SessionGrant = {
    token: "tok",
    expiresAt: clock.now + 300_000,
    gatewayUrl: "https://gateway.example.test",
    visitorId: VISITOR.visitorId,
    inbox: { name: "Example", greeting: null, accentColor: null },
  };
  const ensure = async (force = false) => {
    sessionCalls.push(force);
    if (sessionFailure) throw sessionFailure;
    return grant;
  };
  const session = {
    ensure,
    async token(force = false) {
      return (await ensure(force)).token;
    },
    reset() {},
    grant,
  } as unknown as VisitorSession;

  const calls: { method: Method; args: unknown[] }[] = [];
  const handlers: Partial<Record<Method, (...args: any[]) => unknown>> = {};
  const serverMessages: ReturnType<typeof message>[] = [];
  const defaults: Record<Method, (...args: any[]) => unknown> = {
    listConversations: () => ({
      conversations: [],
      widgetConversationId: null,
    }),
    createConversation: () => ({ conversation: conversation(7) }),
    listMessages: (_id: number, opts: { after?: number }) => ({
      messages: serverMessages.filter((m) => m.id > (opts?.after ?? 0)),
    }),
    sendMessage: (id: number, content: string) => {
      const sent = message(1000 + serverMessages.length, "customer", content);
      sent.conversationId = id;
      serverMessages.push(sent);
      return { message: sent };
    },
    getUnread: () => ({
      unreadCount: 0,
      conversation: null,
      conversations: [],
    }),
    markConversationSeen: (id: number) => ({
      conversationId: id,
      seen: true,
      seenAt: 1,
    }),
  };
  const client = Object.fromEntries(
    (Object.keys(defaults) as Method[]).map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args });
        return (handlers[method] ?? defaults[method])(...args);
      },
    ]),
  ) as any;

  const controller = new MessengerController({
    session,
    store,
    now: () => clock.now,
    timers: clock.timers,
    isVisible: () => visible,
    createClient: () => client,
  });
  const events: ControllerEvent[] = [];
  controller.on((event) => events.push(event));
  return {
    clock,
    store,
    controller,
    calls,
    handlers,
    serverMessages,
    events,
    sessionCalls,
    setVisible(value: boolean) {
      visible = value;
      controller.visibilityChanged();
    },
    failSession(error: unknown) {
      sessionFailure = error;
    },
    count: (method: Method) => calls.filter((c) => c.method === method).length,
  };
}

// ---- polling rules ------------------------------------------------------

test("boot without a conversation contacts nothing until the panel opens", async () => {
  for (const stored of [false, true]) {
    const t = setup({ stored, hasConversation: false });
    t.controller.start();
    await t.clock.advance(10 * 60_000);
    assert.equal(t.calls.length, 0);
    assert.equal(t.sessionCalls.length, 0);
    assert.equal(t.clock.pending(), -1);
  }
});

test("closed with a conversation polls unread 30 s visible, 120 s hidden, 5 min after errors", async () => {
  const t = setup({ hasConversation: true });
  let unread = 2;
  t.handlers.getUnread = () => ({
    unreadCount: unread,
    conversation: null,
    conversations: [],
  });
  t.controller.start();
  await t.clock.advance(0);
  assert.equal(t.count("getUnread"), 1);
  assert.equal(t.controller.state.unread, 2);
  assert.deepEqual(
    t.events.filter((e) => e.type === "unread"),
    [{ type: "unread", count: 2 }],
  );
  assert.equal(t.clock.pending(), POLL.unreadVisible);
  await t.clock.advance(POLL.unreadVisible);
  assert.equal(t.count("getUnread"), 2);

  t.setVisible(false);
  await t.clock.flush();
  assert.equal(t.clock.pending(), POLL.unreadHidden);
  await t.clock.advance(POLL.unreadHidden);
  assert.equal(t.count("getUnread"), 3);

  // Coming back polls immediately.
  t.setVisible(true);
  await t.clock.advance(0);
  assert.equal(t.count("getUnread"), 4);

  t.handlers.getUnread = () => {
    throw new DaykeeperWebTransportError({
      code: "NETWORK_ERROR",
      message: "x",
      retryable: true,
    });
  };
  await t.clock.advance(POLL.unreadVisible);
  assert.equal(t.clock.pending(), POLL.unreadError);
  unread = 0;
  t.handlers.getUnread = undefined;
  await t.clock.advance(POLL.unreadError);
  assert.equal(t.controller.state.unread, 0);
  assert.equal(t.clock.pending(), POLL.unreadVisible);
});

test("open thread polls after=<last id> every 4 s, 15 s when idle, 120 s hidden", async () => {
  const t = setup({ hasConversation: true });
  t.handlers.listConversations = () => ({
    conversations: [conversation(7, { unreadForContact: 1 })],
    widgetConversationId: 7,
  });
  t.serverMessages.push(message(1, "customer"), message(2, "agent"));
  t.controller.open();
  await t.clock.flush();
  assert.equal(t.controller.state.conversations.length, 1);
  assert.equal(t.controller.state.unread, 1);

  t.controller.openConversation(7);
  await t.clock.flush();
  const first = t.calls.filter((c) => c.method === "listMessages");
  assert.deepEqual(first[0]!.args, [7, {}]);
  assert.deepEqual(
    t.controller.state.thread.map((m) => m.id),
    [1, 2],
  );
  // Agent reply rendered → seen once, unread cleared.
  assert.equal(t.count("markConversationSeen"), 1);
  assert.equal(t.controller.state.unread, 0);

  assert.equal(t.clock.pending(), POLL.threadActive);
  await t.clock.advance(POLL.threadActive);
  const second = t.calls.filter((c) => c.method === "listMessages");
  assert.deepEqual(second[1]!.args, [7, { after: 2 }]);
  // No new agent message → no duplicate seen.
  assert.equal(t.count("markConversationSeen"), 1);

  // Two idle minutes → 15 s cadence.
  await t.clock.advance(POLL.idleAfter + 1);
  await t.clock.advance(t.clock.pending());
  assert.equal(t.clock.pending(), POLL.threadIdle);
  t.controller.noteActivity();
  assert.equal(t.clock.pending(), POLL.threadActive);

  t.setVisible(false);
  assert.equal(t.clock.pending(), POLL.threadHidden);
  t.setVisible(true);
  await t.clock.advance(0);

  // A new agent reply: incoming event, seen again.
  t.serverMessages.push(message(3, "human", "Maya here"));
  await t.clock.advance(POLL.threadActive);
  const incoming = t.events.filter((e) => e.type === "incoming");
  assert.equal(incoming.length, 1);
  assert.equal(t.count("markConversationSeen"), 2);
});

test("thread poll errors back off exponentially to 5 minutes", async () => {
  const t = setup({ hasConversation: true });
  t.controller.open();
  t.controller.openConversation(7);
  await t.clock.flush();
  t.handlers.listMessages = () => {
    throw new DaykeeperWebApiError({
      status: 502,
      code: "support_upstream_unavailable",
      retryable: true,
    });
  };
  const delays: number[] = [];
  for (let i = 0; i < 9; i += 1) {
    await t.clock.advance(t.clock.pending());
    delays.push(t.clock.pending());
  }
  assert.deepEqual(
    delays,
    [4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000],
  );
  assert.equal(t.controller.state.degraded, true);
  assert.equal(t.controller.state.phase, "ready");
  t.handlers.listMessages = undefined;
  await t.clock.advance(t.clock.pending());
  assert.equal(t.controller.state.degraded, false);
  // Minutes without new messages: back to the idle cadence, not the backoff.
  assert.equal(t.clock.pending(), POLL.threadIdle);
});

test("an opaque network failure forces a token refresh before the next call", async () => {
  const t = setup({ hasConversation: true });
  t.controller.start();
  await t.clock.advance(0);
  t.handlers.getUnread = () => {
    // What a CORS-hidden 401 looks like from the page.
    throw new DaykeeperWebTransportError({
      code: "NETWORK_ERROR",
      message: "x",
      retryable: true,
    });
  };
  await t.clock.advance(POLL.unreadVisible);
  assert.deepEqual(t.sessionCalls.filter(Boolean), []);
  t.handlers.getUnread = undefined;
  await t.clock.advance(POLL.unreadError);
  assert.deepEqual(t.sessionCalls.filter(Boolean), [true]);
  assert.equal(t.clock.pending(), POLL.unreadVisible);
  await t.clock.advance(POLL.unreadVisible);
  assert.deepEqual(
    t.sessionCalls.filter(Boolean),
    [true],
    "only once per streak",
  );
});

test("home polls the conversation list and marks hasConversation", async () => {
  const t = setup({ hasConversation: false });
  t.handlers.listConversations = () => ({
    conversations: [
      conversation(3, { updatedAt: 1 }),
      conversation(4, { updatedAt: 9 }),
    ],
    widgetConversationId: 4,
  });
  t.controller.open();
  await t.clock.flush();
  assert.deepEqual(
    t.controller.state.conversations.map((c) => c.id),
    [4, 3],
  );
  assert.equal(t.store.read()?.hasConversation, true);
  assert.equal(t.clock.pending(), POLL.homeVisible);
  t.controller.close();
  assert.equal(t.clock.pending(), POLL.unreadVisible);
});

// ---- sending -------------------------------------------------------------

test("first send creates the conversation, then posts; stores hasConversation", async () => {
  const t = setup({ stored: true, hasConversation: false });
  t.controller.newConversation("prefilled");
  await t.clock.flush();
  assert.equal(t.controller.state.open, true);
  assert.equal(t.controller.consumePrefill(), "prefilled");
  assert.equal(t.controller.consumePrefill(), null);
  assert.equal(await t.controller.send("  Hello there  "), true);
  await t.clock.flush();
  assert.deepEqual(
    t.calls.map((c) => c.method).filter((m) => m !== "listMessages"),
    ["createConversation", "sendMessage"],
  );
  assert.deepEqual(t.calls.find((c) => c.method === "sendMessage")!.args, [
    7,
    "Hello there",
  ]);
  assert.equal(t.controller.state.activeId, 7);
  assert.equal(t.store.read()?.hasConversation, true);
  const [sent] = t.controller.state.thread;
  assert.equal(sent!.status, "sent");
  assert.equal(sent!.id, 1000);
  assert.equal(t.controller.state.conversations[0]?.id, 7);
  assert.equal(t.clock.pending(), POLL.threadActive);
});

test("rejects empty and over-long messages locally", async () => {
  const t = setup();
  t.controller.newConversation();
  assert.equal(await t.controller.send("   "), false);
  assert.equal(await t.controller.send("x".repeat(4001)), false);
  assert.equal(await t.controller.send("x".repeat(4000)), true);
});

test("an expired token on a write refreshes once and repeats the write", async () => {
  const t = setup({ hasConversation: true });
  t.controller.open();
  t.controller.openConversation(7);
  await t.clock.flush();
  let attempts = 0;
  t.handlers.sendMessage = (id: number, content: string) => {
    attempts += 1;
    if (attempts === 1)
      throw new DaykeeperWebApiError({ status: 401, code: "expired_token" });
    return {
      message: { ...message(50, "customer", content), conversationId: id },
    };
  };
  await t.controller.send("hi");
  assert.equal(attempts, 2);
  assert.ok(t.sessionCalls.includes(true), "forced a session refresh");
  assert.equal(t.controller.state.thread.at(-1)!.status, "sent");
});

test("an uncertain send is reconciled, never auto-resent", async () => {
  const t = setup({ hasConversation: true });
  t.controller.open();
  t.controller.openConversation(7);
  await t.clock.flush();
  t.handlers.sendMessage = (_id: number, content: string) => {
    // The server stored it, but the response was lost.
    t.serverMessages.push(message(60, "customer", content));
    throw new DaykeeperWebApiError({
      status: 504,
      code: "gateway_timeout",
      outcomeUnknown: true,
    });
  };
  await t.controller.send("did it arrive?");
  assert.equal(t.controller.state.thread.at(-1)!.status, "unconfirmed");
  await t.clock.advance(POLL.threadActive);
  assert.equal(t.count("sendMessage"), 1);
  assert.deepEqual(
    t.controller.state.thread.map((m) => [m.id, m.status]),
    [[60, "sent"]],
  );
});

test("an uncertain send that never shows up becomes a manual retry", async () => {
  const t = setup({ hasConversation: true });
  t.controller.open();
  t.controller.openConversation(7);
  await t.clock.flush();
  t.handlers.sendMessage = () => {
    throw new DaykeeperWebTransportError({
      code: "NETWORK_ERROR",
      message: "x",
      outcomeUnknown: true,
    });
  };
  await t.controller.send("lost");
  for (let i = 0; i < 3; i += 1) await t.clock.advance(POLL.threadActive);
  const last = t.controller.state.thread.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure, "unknown");
  t.handlers.sendMessage = undefined;
  await t.controller.retrySend(last.key);
  assert.equal(t.controller.state.thread.at(-1)!.status, "sent");
});

test("usage limits and content_too_long mark the send failed with a reason", async () => {
  for (const [code, status, failure] of [
    ["daykeeper_usage_limit_exceeded", 429, "limited"],
    ["content_too_long", 400, "tooLong"],
    ["support_upstream_rejected", 422, "failed"],
  ] as const) {
    const t = setup({ hasConversation: true });
    t.controller.open();
    t.controller.openConversation(7);
    await t.clock.flush();
    t.handlers.sendMessage = () => {
      throw new DaykeeperWebApiError({ status, code });
    };
    await t.controller.send("hello");
    const last = t.controller.state.thread.at(-1)!;
    assert.equal(last.status, "failed", code);
    assert.equal(last.failure, failure, code);
  }
});

// ---- connection errors ------------------------------------------------------

test("terminal gateway codes stop all polling", async () => {
  for (const code of ["web_client_disabled", "origin_not_allowed"]) {
    const t = setup({ hasConversation: true });
    t.handlers.getUnread = () => {
      throw new DaykeeperWebApiError({ status: 403, code });
    };
    t.controller.start();
    await t.clock.advance(0);
    assert.equal(t.controller.state.phase, "error");
    assert.equal(t.controller.state.error, code);
    assert.equal(t.clock.pending(), -1);
    t.controller.open();
    await t.clock.flush();
    assert.equal(t.count("getUnread"), 1);
    t.controller.retry();
    await t.clock.flush();
    assert.equal(t.controller.state.error, code);
  }
});

test("session errors surface with their own code through the token provider", async () => {
  const t = setup();
  t.failSession(new MessengerError("web_client_unavailable"));
  t.controller.open();
  await t.clock.flush();
  assert.equal(t.controller.state.phase, "error");
  assert.equal(t.controller.state.error, "web_client_unavailable");
  assert.equal(t.clock.pending(), -1);
});

test("a connection failure while opening retries with backoff and on demand", async () => {
  const t = setup();
  t.failSession(new MessengerError("network_error", { retryable: true }));
  t.controller.open();
  await t.clock.flush();
  assert.equal(t.controller.state.error, "network_error");
  assert.equal(t.clock.pending(), POLL.threadActive);
  t.failSession(null);
  t.controller.retry();
  await t.clock.flush();
  assert.equal(t.controller.state.phase, "ready");
  assert.equal(t.count("listConversations"), 1);
});

test("shutdown cancels timers and ignores later intents", async () => {
  const t = setup({ hasConversation: true });
  t.controller.start();
  await t.clock.advance(0);
  t.controller.shutdown();
  assert.equal(t.clock.pending(), -1);
  t.controller.open();
  assert.equal(t.controller.state.open, false);
});

// ---- pure helpers -----------------------------------------------------------

test("authorOf trusts the gateway label and never infers an AI agent", () => {
  assert.equal(authorOf(message(1, "agent")), "agent");
  assert.equal(authorOf(message(1, "system")), "system");
  const legacy = (type: number) => {
    const m = message(1, "human") as Partial<ReturnType<typeof message>>;
    delete m.author;
    return { ...m, messageType: type } as DaykeeperMessage;
  };
  assert.equal(authorOf(legacy(0)), "customer");
  assert.equal(authorOf(legacy(1)), "human");
  assert.equal(authorOf(legacy(2)), "system");
  assert.equal(
    authorOf({ ...message(1, "agent"), author: "robot" } as never),
    "human",
  );
});

test("mergeServerMessages dedupes, orders, and settles unconfirmed sends", () => {
  const pending = (
    key: string,
    content: string,
    status: ThreadMessage["status"],
  ): ThreadMessage => ({
    key,
    id: null,
    author: "customer",
    senderName: null,
    content,
    createdAt: null,
    status,
  });
  const server = (id: number, content = `m${id}`): ThreadMessage => ({
    key: `m:${id}`,
    id,
    author: "customer",
    senderName: null,
    content,
    createdAt: null,
    status: "sent",
  });
  const merged = mergeServerMessages(
    [
      server(2),
      pending("p:1", "hello", "unconfirmed"),
      pending("p:2", "other", "sending"),
    ],
    [server(1), server(2), server(3, "hello")],
  );
  assert.deepEqual(
    merged.map((m) => m.key),
    ["m:1", "m:2", "m:3", "p:2"],
  );
  const settled = settleUnconfirmed(
    settleUnconfirmed(settleUnconfirmed([pending("p:9", "x", "unconfirmed")])),
  );
  assert.equal(settled[0]!.status, "failed");
});
