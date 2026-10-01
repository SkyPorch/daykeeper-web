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
  attachmentCount?: number;
  createdAt: number | null;
  status: SendStatus;
  failure?: SendFailure;
  /** First conversation creation had an unknown outcome; reconcile before any retry. */
  reconcile?: boolean;
  /** New conversations found after an uncertain create; user chooses explicitly. */
  reconcileCandidates?: ConversationSummary[];
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
  historyExhausted: boolean;
  historyCursorBefore: number | null;
  historyLoading: boolean;
  historyError: boolean;
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
const MAX_FORWARD_PAGES_PER_TICK = 10;
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
    historyExhausted: false,
    historyCursorBefore: null,
    historyLoading: false,
    historyError: false,
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
  /** Highest server id returned by listMessages for the current open thread. */
  #lastFetchedMessageId: number | null = null;
  #orphanedConversation: DaykeeperConversation | null = null;
  /**
   * The gateway reflects CORS only after it verified the token, so an
   * expired or rejected token reaches us as an opaque network failure, not a
   * readable 401. After such a failure the next call exchanges a fresh token
   * first (once per failure streak).
   */
  #suspectToken = false;
  #creatingConversation: Promise<DaykeeperConversation> | null = null;
  #uncertainCreateIds: Set<number> | null = null;
  #uncertainCreateChecked = false;

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
    this.#threadToken += 1;
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
    this.#lastFetchedMessageId = null;
    this.#set({
      view: "home",
      activeId: null,
      thread: [],
      threadLoaded: false,
      historyExhausted: false,
      historyCursorBefore: null,
      historyLoading: false,
      historyError: false,
    });
    void this.#refreshOpen();
  }

  openConversation(id: number): void {
    this.#threadToken += 1;
    this.#lastFetchedMessageId = null;
    this.#touch();
    this.#set({
      view: "thread",
      activeId: id,
      thread: [],
      threadLoaded: false,
      historyExhausted: false,
      historyCursorBefore: null,
      historyLoading: false,
      historyError: false,
    });
    void this.#refreshOpen();
  }

  newConversation(prefill: string | null = null): void {
    this.#threadToken += 1;
    this.#lastFetchedMessageId = null;
    this.#touch();
    this.#set({
      view: "thread",
      activeId: null,
      thread: [],
      threadLoaded: true,
      historyExhausted: true,
      historyCursorBefore: null,
      historyLoading: false,
      historyError: false,
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

  async loadOlderMessages(): Promise<void> {
    const id = this.state.activeId;
    if (
      id === null ||
      !this.state.threadLoaded ||
      this.state.historyExhausted ||
      this.state.historyLoading
    )
      return;
    const before =
      this.state.historyCursorBefore ?? firstServerId(this.state.thread);
    if (before === null) {
      this.#set({ historyExhausted: true, historyError: false });
      return;
    }
    const threadToken = this.#threadToken;
    this.#set({ historyLoading: true, historyError: false });
    try {
      const client = await this.#ensureConnected();
      if (!client) throw new MessengerError(this.state.error ?? "unknown");
      const { messages } = await client.listMessages(id, { before });
      if (threadToken !== this.#threadToken) return;
      const older = messages
        .map(toThreadMessage)
        .filter((entry): entry is ThreadMessage => entry !== null);
      const known = new Set(this.state.thread.map((entry) => entry.id));
      this.#set({
        thread: mergeServerMessages(
          this.state.thread,
          older.filter((entry) => !known.has(entry.id)),
          false,
        ),
        // Cursor/exhaustion follows raw provider-visible records, not only
        // records we can render. Empty text-only historical events are still
        // a real page and must advance the `before` cursor.
        historyCursorBefore: minimumMessageId(messages),
        historyExhausted: messages.length === 0,
        historyLoading: false,
        historyError: false,
      });
    } catch {
      if (threadToken === this.#threadToken) {
        this.#set({ historyLoading: false, historyError: true });
      }
    }
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
      attachmentCount: 0,
      createdAt: this.#env.now(),
      status: "sending",
    };
    this.#set({ thread: [...this.state.thread, pending] });
    await this.#deliver(pending.key);
    return true;
  }

  async retrySend(key: string): Promise<void> {
    const message = this.state.thread.find((entry) => entry.key === key);
    if (
      !message ||
      (message.status !== "failed" &&
        !(message.status === "unconfirmed" && message.reconcile))
    )
      return;
    this.#patchMessage(key, {
      status: "sending",
      failure: undefined,
      reconcile: message.reconcile,
    });
    await this.#deliver(key);
  }

  /** Let the visitor choose a newly appeared conversation before retrying. */
  async selectReconciledConversation(key: string, id: number): Promise<void> {
    const pending = this.state.thread.find((entry) => entry.key === key);
    const candidate = pending?.reconcileCandidates?.find(
      (entry) => entry.id === id,
    );
    if (!pending || !candidate || pending.status !== "unconfirmed") return;
    this.#uncertainCreateIds = null;
    this.#uncertainCreateChecked = false;
    this.#set({
      activeId: id,
      conversations: upsertConversation(this.state.conversations, candidate),
    });
    this.#patchMessage(key, {
      status: "failed",
      failure: "unknown",
      reconcile: false,
      reconcileCandidates: undefined,
    });
    await this.retrySend(key);
  }

  // ---- delivery --------------------------------------------------------

  async #deliver(key: string): Promise<void> {
    const threadToken = this.#threadToken;
    const isCurrent = () => !this.#stopped && threadToken === this.#threadToken;
    const current = () => this.state.thread.find((entry) => entry.key === key);
    try {
      const client = await this.#ensureConnected();
      if (!isCurrent()) return;
      if (!client) throw new MessengerError(this.state.error ?? "unknown");
      await this.#refreshIfSuspect();
      if (!isCurrent()) return;
      let conversationId = this.state.activeId;
      if (conversationId === null) {
        const conversation = await this.#getOrCreateConversation(
          client,
          isCurrent,
          key,
        );
        if (!isCurrent()) return;
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
      if (error.outcomeUnknown) {
        // Both a message write and first-conversation creation can have
        // succeeded when their response is lost. Reconcile before offering a
        // retry so a second conversation or message is never created blindly.
        this.#patchMessage(key, {
          status: "unconfirmed",
          failure: "unknown",
          reconcile: this.#uncertainCreateIds !== null,
        });
        this.#schedule(
          this.state.activeId === null ? POLL.homeVisible : POLL.threadActive,
        );
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

  async #getOrCreateConversation(
    client: Client,
    isCurrent: () => boolean,
    messageKey: string,
  ): Promise<DaykeeperConversation> {
    if (!isCurrent()) throw new MessengerError("unknown");
    if (this.#orphanedConversation) {
      const conversation = this.#orphanedConversation;
      this.#orphanedConversation = null;
      return conversation;
    }
    if (this.#uncertainCreateIds) {
      const alreadyChecked = this.#uncertainCreateChecked;
      await this.#reconcileConversation(client, messageKey, isCurrent);
      if (!isCurrent()) throw new MessengerError("unknown");
      if (!alreadyChecked || !this.#uncertainCreateChecked) {
        throw new MessengerError("network_error", {
          retryable: true,
          outcomeUnknown: true,
        });
      }
      // A completed contact-conversation read has now found no result twice
      // (the immediate reconciliation and this explicit retry). Only then let
      // the customer's manual retry create again instead of wedging forever.
      this.#uncertainCreateIds = null;
      this.#uncertainCreateChecked = false;
    }
    if (!this.#creatingConversation) {
      this.#creatingConversation = (async () => {
        const { conversations: before } = await client.listConversations();
        if (!isCurrent()) throw new MessengerError("unknown");
        const beforeIds = new Set(before.map((entry) => entry.id));
        try {
          const { conversation } = await this.#write(() =>
            client.createConversation(),
          );
          if (!isCurrent()) {
            // The user navigated away while creation was in flight. Keep the
            // known successful result so a later draft does not create a
            // second conversation for the same visitor.
            this.#orphanedConversation = conversation;
            throw new MessengerError("unknown");
          }
          this.#uncertainCreateIds = null;
          this.#uncertainCreateChecked = false;
          return conversation;
        } catch (raw) {
          const error = this.#mapError(raw);
          if (!error.outcomeUnknown) throw error;
          this.#uncertainCreateIds = beforeIds;
          this.#uncertainCreateChecked = false;
          if (!isCurrent()) throw error;
          await this.#reconcileConversation(client, messageKey, isCurrent);
          if (!isCurrent()) throw error;
          throw error;
        }
      })().finally(() => {
        this.#creatingConversation = null;
      });
    }
    return this.#creatingConversation;
  }

  async #reconcileConversation(
    client: Client,
    messageKey: string,
    isCurrent: () => boolean = () => !this.#stopped,
  ): Promise<void> {
    const beforeIds = this.#uncertainCreateIds;
    if (!beforeIds) return;
    const { conversations } = await client.listConversations();
    if (!isCurrent()) return;
    const candidates = conversations.filter(
      (entry) => !beforeIds.has(entry.id),
    );
    if (candidates.length === 0) {
      this.#uncertainCreateChecked = true;
      this.#patchMessage(messageKey, { reconcileCandidates: undefined });
      return;
    }
    this.#uncertainCreateChecked = false;
    this.#patchMessage(messageKey, {
      reconcileCandidates: candidates.map(summarize),
    });
    this.#markHasConversation();
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
    if (this.#stopped) return;
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
    // Customer send responses can have an id above messages that arrived
    // while the thread was open. Advance only from listMessages responses so
    // a local send can never jump over unseen incoming replies.
    let after = initial ? undefined : (this.#lastFetchedMessageId ?? undefined);
    let firstPage = true;
    let exhaustedForwardPages = false;
    for (
      let pageNumber = 0;
      pageNumber < MAX_FORWARD_PAGES_PER_TICK;
      pageNumber++
    ) {
      const requestedAfter = after;
      const { messages } = await client.listMessages(
        id,
        requestedAfter === undefined ? {} : { after: requestedAfter },
      );
      if (threadToken !== this.#threadToken) return;
      if (messages.length === 0) {
        if (requestedAfter === undefined) {
          this.#set({
            threadLoaded: true,
            historyCursorBefore: null,
            historyExhausted: true,
          });
        }
        exhaustedForwardPages = true;
        break;
      }

      const fetchedId = maximumMessageId(messages);
      if (
        fetchedId === null ||
        (requestedAfter !== undefined && fetchedId <= requestedAfter)
      ) {
        throw new DaykeeperWebTransportError({
          code: "INVALID_RESPONSE",
          message:
            "The Daykeeper customer API returned invalid message cursors",
          retryable: true,
        });
      }
      this.#lastFetchedMessageId = fetchedId;
      after = fetchedId;
      const mapped = messages
        .map(toThreadMessage)
        .filter((entry): entry is ThreadMessage => entry !== null);
      const known = new Set<number | null>(
        this.state.thread.map((entry) => entry.id),
      );
      const fresh = mapped.filter((entry) => !known.has(entry.id));
      const thread = mergeServerMessages(this.state.thread, fresh);
      this.#set({
        thread,
        threadLoaded: true,
        historyCursorBefore:
          requestedAfter === undefined
            ? minimumMessageId(messages)
            : this.state.historyCursorBefore,
        // A no-cursor page can arrive after an empty conversation was first
        // read; those messages make older-history loading available again.
        historyExhausted:
          requestedAfter === undefined ? false : this.state.historyExhausted,
      });
      const incoming = fresh.filter(
        (entry) => entry.author === "agent" || entry.author === "human",
      );
      if (incoming.length) {
        this.#touch();
        if (!initial || !firstPage)
          this.#emit({ type: "incoming", messages: incoming });
      }
      firstPage = false;
    }

    // The provider's seen endpoint marks the whole conversation. Do not call
    // it while there are still forward pages; doing so would mark records the
    // visitor has not loaded as seen. Also defer uncertain-send failure checks
    // until a complete catch-up, so a later page can still reconcile a send.
    if (exhaustedForwardPages) {
      this.#set({ thread: settleUnconfirmed(this.state.thread) });
      await this.#markSeen(client, id);
    }
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
    if (activeId === null) {
      if (!this.#uncertainCreateIds) return -1;
      return visible ? POLL.homeVisible : POLL.homeHidden;
    }
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
  const attachmentCount = Array.isArray(message.attachments)
    ? message.attachments.length
    : 0;
  if (!content.trim() && attachmentCount === 0) return null;
  return {
    key: `m:${message.id}`,
    id: message.id,
    author: authorOf(message),
    senderName:
      typeof message.sender?.name === "string" && message.sender.name.trim()
        ? message.sender.name.trim().slice(0, 80)
        : null,
    content,
    attachmentCount,
    createdAt: toMillis(message.createdAt),
    status: "sent",
  };
}

function firstServerId(thread: ThreadMessage[]): number | null {
  const ids = thread
    .map((entry) => entry.id)
    .filter(
      (id): id is number => id !== null && Number.isSafeInteger(id) && id > 0,
    );
  return ids.length ? Math.min(...ids) : null;
}

function minimumMessageId(messages: DaykeeperMessage[]): number | null {
  let min = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (Number.isSafeInteger(message.id) && message.id > 0) {
      min = Math.min(min, message.id);
    }
  }
  return Number.isFinite(min) ? min : null;
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

function maximumMessageId(messages: DaykeeperMessage[]): number | null {
  let max = 0;
  for (const message of messages) {
    if (Number.isSafeInteger(message.id) && message.id > max) max = message.id;
  }
  return max || null;
}

/**
 * Merge server messages into the thread: dedupe by id, keep local pending
 * sends at the end, and settle an unconfirmed send when the server shows a
 * customer message with the same text.
 */
export function mergeServerMessages(
  thread: ThreadMessage[],
  fresh: ThreadMessage[],
  settleUnconfirmed = true,
): ThreadMessage[] {
  const byId = new Map<number, ThreadMessage>();
  const local: ThreadMessage[] = [];
  for (const entry of thread) {
    if (entry.id !== null) byId.set(entry.id, entry);
    else local.push(entry);
  }
  for (const entry of fresh) {
    if (entry.id === null) continue;
    const match = settleUnconfirmed
      ? local.findIndex(
          (pending) =>
            pending.status === "unconfirmed" &&
            entry.author === "customer" &&
            pending.content === entry.content.trim(),
        )
      : -1;
    if (match >= 0) local.splice(match, 1);
    byId.set(entry.id, entry);
  }
  const settled = [...byId.values()].sort((a, b) => a.id! - b.id!);
  return [...settled, ...local];
}
