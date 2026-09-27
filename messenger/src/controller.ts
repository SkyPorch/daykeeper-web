import {
  createDaykeeperWebClient,
  DaykeeperWebTransportError,
  type DaykeeperConversation,
  type DaykeeperMessage,
  type DaykeeperWebClient,
} from "../../src/index.ts";
import {
  isTerminal,
  MessengerError,
  toMessengerError,
  type MessengerErrorCode,
} from "./errors.ts";
import type { InboxInfo, VisitorSession } from "./session.ts";
import type { VisitorStore } from "./storage.ts";
import { toMillis } from "./time.ts";

/**
 * The messenger's state machine: session, polling cadence, conversations,
 * the open thread, optimistic sends, and unread. It owns no DOM; the view
 * subscribes to `change` and reads `state`. Time, timers, visibility and the
 * web client are injected so every rule below is unit-testable.
 *
 * Polling (SPEC §5):
 * - closed, visitor has a conversation: GET /v1/unread every 30 s while the
 *   page is visible, 120 s while hidden, 5 min after an error;
 * - open thread: GET …/messages?after=<last id> every 4 s, 15 s after two
 *   idle minutes, 120 s while hidden; errors back off exponentially to 5 min;
 * - open home: the conversation list every 30 s (120 s hidden).
 * Nothing contacts the network until the panel opens or the stored visitor
 * already has a conversation.
 */

export type Author = "customer" | "agent" | "human" | "system";
export type SendStatus = "sent" | "sending" | "failed" | "unconfirmed";
export type SendFailure = "limited" | "failed" | "unknown" | "tooLong";

export interface ThreadMessage {
  key: string;
  id: number | null;
  author: Author;
  senderName: string | null;
  content: string;
  createdAt: number | null;
  status: SendStatus;
  failure?: SendFailure;
  /** Polls that have not yet shown an unconfirmed send on the server. */
  checks?: number;
}

export interface ConversationSummary {
  id: number;
  status: string;
  updatedAt: number | null;
  unread: number;
  preview: string | null;
}

export type Phase = "idle" | "connecting" | "ready" | "error";
export type View = "home" | "thread";

export interface MessengerState {
  open: boolean;
  view: View;
  phase: Phase;
  error: MessengerErrorCode | null;
  /** Reads are failing after we were connected; data shown may be stale. */
  degraded: boolean;
  inbox: InboxInfo | null;
  conversations: ConversationSummary[];
  conversationsLoaded: boolean;
  /** null while composing a brand-new conversation. */
  activeId: number | null;
  thread: ThreadMessage[];
  threadLoaded: boolean;
  unread: number;
  /** Text to prefill once (showNewMessage); the view clears it. */
  prefill: string | null;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ControllerEnvironment {
  session: VisitorSession;
  store: VisitorStore;
  now?: () => number;
  timers?: Timers;
  isVisible?: () => boolean;
  createClient?: (
    gatewayUrl: string,
    getToken: (force: boolean) => Promise<string>,
  ) => Pick<
    DaykeeperWebClient,
    | "listConversations"
    | "createConversation"
    | "listMessages"
    | "sendMessage"
    | "getUnread"
    | "markConversationSeen"
  >;
}

export const MAX_MESSAGE_LENGTH = 4_000;
export const POLL = {
  unreadVisible: 30_000,
  unreadHidden: 120_000,
  unreadError: 300_000,
  threadActive: 4_000,
  threadIdle: 15_000,
  threadHidden: 120_000,
  idleAfter: 120_000,
  homeVisible: 30_000,
  homeHidden: 120_000,
  maxBackoff: 300_000,
} as const;

type Listener = (event: ControllerEvent) => void;
export type ControllerEvent =
  | { type: "change" }
  | { type: "unread"; count: number }
  | { type: "incoming"; messages: ThreadMessage[] };

type Client = ReturnType<NonNullable<ControllerEnvironment["createClient"]>>;

const AUTHORS = new Set<Author>(["customer", "agent", "human", "system"]);

export class MessengerController {
  state: MessengerState = {
    open: false,
    view: "home",
    phase: "idle",
    error: null,
    degraded: false,
    inbox: null,
    conversations: [],
    conversationsLoaded: false,
    activeId: null,
    thread: [],
    threadLoaded: false,
    unread: 0,
    prefill: null,
  };

  readonly #env: Required<Omit<ControllerEnvironment, "createClient">> &
    Pick<ControllerEnvironment, "createClient">;
  #listeners = new Set<Listener>();
  #client: Client | null = null;
  #clientGateway = "";
  #timer: unknown = null;
  #busy = false;
  #failures = 0;
  #lastActivity = 0;
  #seenUpTo = new Map<number, number>();
  #localSeq = 0;
  #connecting: Promise<boolean> | null = null;
  #sessionError: MessengerError | null = null;
  #stopped = false;
  #threadToken = 0;
  /**
   * The gateway reflects CORS only after it verified the token, so an
   * expired or rejected token reaches us as an opaque network failure, not a
   * readable 401. After such a failure the next call exchanges a fresh token
   * first (once per failure streak).
   */
  #suspectToken = false;

  constructor(env: ControllerEnvironment) {
    this.#env = {
      now: Date.now,
      timers: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      isVisible: () =>
        typeof document === "undefined" ||
        document.visibilityState !== "hidden",
      ...env,
    };
  }

  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Boot: resume polling only for a visitor who already has a conversation. */
  start(): void {
    this.#schedule(0);
  }

  shutdown(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#listeners.clear();
    this.#env.session.reset();
  }

  // ---- visitor intents -------------------------------------------------

  open(): void {
    if (this.#stopped || this.state.open) return;
    this.#touch();
    this.#set({ open: true });
    void this.#refreshOpen();
  }

  close(): void {
    if (!this.state.open) return;
    this.#set({ open: false });
    this.#reschedule();
  }

  toggle(): void {
    if (this.state.open) this.close();
    else this.open();
  }

  showHome(): void {
    this.#threadToken += 1;
    this.#set({
      view: "home",
      activeId: null,
      thread: [],
      threadLoaded: false,
    });
    void this.#refreshOpen();
  }

  openConversation(id: number): void {
    this.#threadToken += 1;
    this.#touch();
    this.#set({
      view: "thread",
      activeId: id,
      thread: [],
      threadLoaded: false,
    });
    void this.#refreshOpen();
  }

  newConversation(prefill: string | null = null): void {
    this.#threadToken += 1;
    this.#touch();
    this.#set({
      view: "thread",
      activeId: null,
      thread: [],
      threadLoaded: true,
      prefill,
    });
    if (!this.state.open) this.open();
    else void this.#refreshOpen();
  }

  consumePrefill(): string | null {
    const value = this.state.prefill;
    if (value !== null) this.state.prefill = null;
    return value;
  }

  /** The visitor is typing or scrolling: keep the fast polling cadence. */
  noteActivity(): void {
    const wasIdle = this.#isIdle();
    this.#touch();
    if (wasIdle) this.#reschedule();
  }

  visibilityChanged(): void {
    if (this.#env.isVisible()) {
      // Coming back: catch up now rather than at the hidden cadence.
      this.#schedule(0);
    } else {
      this.#reschedule();
    }
  }

  retry(): void {
    if (this.state.phase === "error" && isTerminal(this.state.error!)) return;
    this.#failures = 0;
    this.#set({ phase: "idle", error: null });
    void this.#refreshOpen();
  }

  async send(text: string): Promise<boolean> {
    const content = text.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH || this.#stopped)
      return false;
    this.#touch();
    const pending: ThreadMessage = {
      key: `p:${++this.#localSeq}`,
      id: null,
      author: "customer",
      senderName: null,
      content,
      createdAt: this.#env.now(),
      status: "sending",
    };
    this.#set({ thread: [...this.state.thread, pending] });
    await this.#deliver(pending.key);
    return true;
  }

  async retrySend(key: string): Promise<void> {
    const message = this.state.thread.find((entry) => entry.key === key);
    if (!message || message.status !== "failed") return;
    this.#patchMessage(key, { status: "sending", failure: undefined });
    await this.#deliver(key);
  }

  // ---- delivery --------------------------------------------------------

  async #deliver(key: string): Promise<void> {
    const threadToken = this.#threadToken;
    const current = () => this.state.thread.find((entry) => entry.key === key);
    try {
      const client = await this.#ensureConnected();
      if (!client) throw new MessengerError(this.state.error ?? "unknown");
      await this.#refreshIfSuspect();
      let conversationId = this.state.activeId;
      if (conversationId === null) {
        const { conversation } = await this.#write(() =>
          client.createConversation(),
        );
        conversationId = conversation.id;
        this.#markHasConversation();
        if (threadToken === this.#threadToken) {
          this.#set({
            activeId: conversationId,
            conversations: upsertConversation(
              this.state.conversations,
              summarize(conversation),
            ),
          });
        }
      }
      const message = current();
      if (!message) return;
      const { message: sent } = await this.#write(() =>
        client.sendMessage(conversationId!, message.content),
      );
      if (threadToken !== this.#threadToken) return;
      const mapped = toThreadMessage(sent);
      this.#set({
        thread: mergeServerMessages(
          this.state.thread.map((entry) =>
            entry.key === key && mapped ? mapped : entry,
          ),
          [],
        ),
      });
      this.#reschedule();
    } catch (raw) {
      const error = this.#mapError(raw);
      if (error.code === "network_error") this.#suspectToken = true;
      if (threadToken !== this.#threadToken) return;
      if (error.outcomeUnknown && this.state.activeId !== null) {
        // The server may have accepted it. Reconcile against the thread on
        // the next poll instead of offering a resend that could duplicate.
        this.#patchMessage(key, { status: "unconfirmed", failure: "unknown" });
        this.#schedule(POLL.threadActive);
        return;
      }
      if (isTerminal(error.code)) this.#fail(error);
      this.#patchMessage(key, {
        status: "failed",
        failure:
          error.code === "usage_limited"
            ? "limited"
            : error.code === "content_too_long"
              ? "tooLong"
              : "failed",
      });
    }
  }

  async #refreshIfSuspect(): Promise<void> {
    if (!this.#suspectToken) return;
    this.#suspectToken = false;
    await this.#env.session.ensure(true);
  }

  /** A write whose token was rejected is safe to repeat once: nothing ran. */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (raw) {
      const error = this.#mapError(raw);
      if (!error.authFailure || error.outcomeUnknown) throw error;
      await this.#env.session.ensure(true);
      return operation();
    }
  }

  // ---- connection ------------------------------------------------------

  async #ensureConnected(): Promise<Client | null> {
    if (this.#client && this.state.phase === "ready") return this.#client;
    if (!this.#connecting) {
      this.#connecting = this.#connect().finally(() => {
        this.#connecting = null;
      });
    }
    return (await this.#connecting) ? this.#client : null;
  }

  async #connect(): Promise<boolean> {
    if (this.state.phase !== "ready") {
      this.#set({ phase: "connecting", error: null });
    }
    try {
      const grant = await this.#env.session.ensure();
      if (this.#stopped) return false;
      if (!this.#client || this.#clientGateway !== grant.gatewayUrl) {
        const factory =
          this.#env.createClient ??
          ((baseUrl, getToken) =>
            createDaykeeperWebClient({
              baseUrl,
              getAccessToken: ({ forceRefresh }) => getToken(forceRefresh),
            }));
        this.#client = factory(grant.gatewayUrl, (force) =>
          this.#env.session.token(force).catch((error: unknown) => {
            this.#sessionError = toMessengerError(error);
            throw error;
          }),
        );
        this.#clientGateway = grant.gatewayUrl;
      }
      this.#set({ phase: "ready", error: null, inbox: grant.inbox });
      return true;
    } catch (raw) {
      this.#fail(this.#mapError(raw));
      return false;
    }
  }

  #fail(error: MessengerError): void {
    this.#failures += 1;
    this.#set({ phase: "error", error: error.code });
  }

  #mapError(raw: unknown): MessengerError {
    if (
      raw instanceof DaykeeperWebTransportError &&
      raw.code === "TOKEN_PROVIDER_ERROR" &&
      this.#sessionError
    ) {
      const error = this.#sessionError;
      this.#sessionError = null;
      return error;
    }
    return toMessengerError(raw);
  }

  // ---- polling ---------------------------------------------------------

  async #refreshOpen(): Promise<void> {
    this.#clearTimer();
    await this.#tick();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    if (this.#busy) {
      this.#schedule(250);
      return;
    }
    this.#busy = true;
    try {
      const { open, view, activeId } = this.state;
      if (!open && !this.#env.store.read()?.hasConversation) return;
      if (this.state.phase === "error" && isTerminal(this.state.error!)) return;
      const client = await this.#ensureConnected();
      if (!client) return;
      await this.#refreshIfSuspect();
      if (!open) await this.#pollUnread(client);
      else if (view === "home") await this.#pollConversations(client);
      else if (activeId !== null) await this.#pollThread(client, activeId);
      this.#failures = 0;
      if (this.state.degraded) this.#set({ degraded: false });
    } catch (raw) {
      const error = this.#mapError(raw);
      this.#failures += 1;
      if (error.code === "network_error" && this.#failures === 1)
        this.#suspectToken = true;
      if (isTerminal(error.code)) this.#fail(error);
      else if (this.state.phase === "ready") this.#set({ degraded: true });
      else this.#fail(error);
    } finally {
      this.#busy = false;
      this.#reschedule();
    }
  }

  async #pollUnread(client: Client): Promise<void> {
    const summary = await client.getUnread();
    this.#setUnread(Math.max(0, Number(summary.unreadCount) || 0));
  }

  async #pollConversations(client: Client): Promise<void> {
    const { conversations } = await client.listConversations();
    const list = conversations
      .map(summarize)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (list.length) this.#markHasConversation();
    this.#set({ conversations: list, conversationsLoaded: true });
    this.#setUnread(list.reduce((sum, entry) => sum + entry.unread, 0));
  }

  async #pollThread(client: Client, id: number): Promise<void> {
    const threadToken = this.#threadToken;
    const initial = !this.state.threadLoaded;
    const after = initial ? undefined : lastServerId(this.state.thread);
    const { messages } = await client.listMessages(id, after ? { after } : {});
    if (threadToken !== this.#threadToken) return;
    const mapped = messages
      .map(toThreadMessage)
      .filter((entry): entry is ThreadMessage => entry !== null);
    const known = new Set<number | null>(
      this.state.thread.map((entry) => entry.id),
    );
    const fresh = mapped.filter((entry) => !known.has(entry.id));
    const thread = settleUnconfirmed(
      mergeServerMessages(this.state.thread, fresh),
    );
    this.#set({ thread, threadLoaded: true });
    const incoming = fresh.filter(
      (entry) => entry.author === "agent" || entry.author === "human",
    );
    if (incoming.length) {
      this.#touch();
      if (!initial) this.#emit({ type: "incoming", messages: incoming });
    }
    await this.#markSeen(client, id);
  }

  /** POST …/seen once agent/human replies are on screen. */
  async #markSeen(client: Client, id: number): Promise<void> {
    if (!this.state.open || !this.#env.isVisible()) return;
    const newest = this.state.thread.reduce(
      (max, entry) =>
        (entry.author === "agent" || entry.author === "human") &&
        entry.id !== null
          ? Math.max(max, entry.id)
          : max,
      0,
    );
    if (!newest || (this.#seenUpTo.get(id) ?? 0) >= newest) return;
    this.#seenUpTo.set(id, newest);
    try {
      await this.#write(() => client.markConversationSeen(id));
    } catch {
      this.#seenUpTo.delete(id);
      return;
    }
    const conversations = this.state.conversations.map((entry) =>
      entry.id === id ? { ...entry, unread: 0 } : entry,
    );
    this.#set({ conversations });
    this.#setUnread(
      conversations.reduce((sum, entry) => sum + entry.unread, 0),
    );
  }

  #reschedule(): void {
    this.#schedule(this.nextDelay());
  }

  /** Milliseconds until the next poll for the current state, or -1 for none. */
  nextDelay(): number {
    if (this.#stopped) return -1;
    const { open, view, activeId, phase, error } = this.state;
    if (phase === "error" && error && isTerminal(error)) return -1;
    const visible = this.#env.isVisible();
    const hasUnconfirmed = this.state.thread.some(
      (entry) => entry.status === "unconfirmed",
    );
    if (!open) {
      if (!this.#env.store.read()?.hasConversation) return -1;
      if (this.#failures > 0) return POLL.unreadError;
      return visible ? POLL.unreadVisible : POLL.unreadHidden;
    }
    const backoff =
      this.#failures > 0
        ? Math.min(
            POLL.maxBackoff,
            POLL.threadActive * 2 ** Math.min(this.#failures - 1, 10),
          )
        : 0;
    if (phase === "error") return Math.max(backoff, POLL.threadActive);
    if (view === "home") {
      return Math.max(backoff, visible ? POLL.homeVisible : POLL.homeHidden);
    }
    if (activeId === null) return -1;
    if (!visible && !hasUnconfirmed) return POLL.threadHidden;
    const base = this.#isIdle() ? POLL.threadIdle : POLL.threadActive;
    return Math.max(backoff, base);
  }

  #schedule(ms: number): void {
    this.#clearTimer();
    if (ms < 0 || this.#stopped) return;
    this.#timer = this.#env.timers.setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, ms);
  }

  #clearTimer(): void {
    if (this.#timer !== null) this.#env.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  // ---- helpers ---------------------------------------------------------

  #isIdle(): boolean {
    return this.#env.now() - this.#lastActivity > POLL.idleAfter;
  }

  #touch(): void {
    this.#lastActivity = this.#env.now();
  }

  #markHasConversation(): void {
    const stored = this.#env.store.read();
    if (stored && !stored.hasConversation) {
      this.#env.store.write({ ...stored, hasConversation: true });
    }
  }

  #patchMessage(key: string, patch: Partial<ThreadMessage>): void {
    this.#set({
      thread: this.state.thread.map((entry) =>
        entry.key === key ? { ...entry, ...patch } : entry,
      ),
    });
  }

  #setUnread(count: number): void {
    if (count === this.state.unread) return;
    this.#set({ unread: count });
    this.#emit({ type: "unread", count });
  }

  #set(patch: Partial<MessengerState>): void {
    this.state = { ...this.state, ...patch };
    this.#emit({ type: "change" });
  }

  #emit(event: ControllerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A host callback must never break the messenger.
      }
    }
  }
}

// ---- pure helpers (exported for tests) ----------------------------------

export function authorOf(message: DaykeeperMessage): Author {
  const declared = (message as { author?: unknown }).author;
  if (typeof declared === "string" && AUTHORS.has(declared as Author)) {
    return declared as Author;
  }
  // Gateways before author labels: incoming = customer, activity = system.
  // An outgoing reply is never *claimed* to be an AI agent without the label.
  if (message.messageType === 0) return "customer";
  if (message.messageType === 2) return "system";
  return "human";
}

export function toThreadMessage(
  message: DaykeeperMessage,
): ThreadMessage | null {
  if (!message || !Number.isSafeInteger(message.id) || message.id < 1)
    return null;
  const content = typeof message.content === "string" ? message.content : "";
  if (!content.trim()) return null;
  return {
    key: `m:${message.id}`,
    id: message.id,
    author: authorOf(message),
    senderName:
      typeof message.sender?.name === "string" && message.sender.name.trim()
        ? message.sender.name.trim().slice(0, 80)
        : null,
    content,
    createdAt: toMillis(message.createdAt),
    status: "sent",
  };
}

export function summarize(
  conversation: DaykeeperConversation,
): ConversationSummary {
  return {
    id: conversation.id,
    status: conversation.status,
    updatedAt: toMillis(conversation.updatedAt ?? conversation.createdAt),
    unread: Math.max(0, Number(conversation.unreadForContact) || 0),
    preview:
      typeof conversation.preview === "string" && conversation.preview.trim()
        ? conversation.preview.trim()
        : null,
  };
}

function upsertConversation(
  list: ConversationSummary[],
  entry: ConversationSummary,
): ConversationSummary[] {
  return [entry, ...list.filter((item) => item.id !== entry.id)];
}

/**
 * An unconfirmed send that two further polls still do not show was most
 * likely lost: offer the visitor a manual resend.
 */
export function settleUnconfirmed(thread: ThreadMessage[]): ThreadMessage[] {
  return thread.map((entry) => {
    if (entry.status !== "unconfirmed") return entry;
    const checks = (entry.checks ?? 0) + 1;
    return checks > 2
      ? { ...entry, status: "failed", failure: "unknown", checks }
      : { ...entry, checks };
  });
}

function lastServerId(thread: ThreadMessage[]): number | undefined {
  let max = 0;
  for (const entry of thread)
    if (entry.id !== null && entry.id > max) max = entry.id;
  return max || undefined;
}

/**
 * Merge server messages into the thread: dedupe by id, keep local pending
 * sends at the end, and settle an unconfirmed send when the server shows a
 * customer message with the same text.
 */
export function mergeServerMessages(
  thread: ThreadMessage[],
  fresh: ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map<number, ThreadMessage>();
  const local: ThreadMessage[] = [];
  for (const entry of thread) {
    if (entry.id !== null) byId.set(entry.id, entry);
    else local.push(entry);
  }
  for (const entry of fresh) {
    if (entry.id === null) continue;
    const match = local.findIndex(
      (pending) =>
        pending.status === "unconfirmed" &&
        entry.author === "customer" &&
        pending.content === entry.content.trim(),
    );
    if (match >= 0) local.splice(match, 1);
    byId.set(entry.id, entry);
  }
  const settled = [...byId.values()].sort((a, b) => a.id! - b.id!);
  return [...settled, ...local];
}
