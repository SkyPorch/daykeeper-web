import { poweredByUrl } from "./branding.ts";
import { onColor } from "./color.ts";
import {
  MAX_MESSAGE_LENGTH,
  type ConversationSummary,
  type MessengerController,
  type MessengerState,
  type ThreadMessage,
} from "./controller.ts";
import { h, icon, initial, initials } from "./dom.ts";
import type { MessengerErrorCode } from "./errors.ts";
import { renderRichText } from "./richText.ts";
import type { Strings } from "./strings.ts";
import { css } from "./styles.ts";
import { absoluteTime, relativeTime } from "./time.ts";

export interface ViewOptions {
  theme: "auto" | "light" | "dark";
  position: "right" | "left";
  hideLauncher: boolean;
  zIndex: number;
  locale: string | undefined;
  strings: Strings;
}

type Screen = "none" | "home" | "thread" | "state" | "loading";

const MOBILE_QUERY = "(max-width: 639.98px)";
const GROUP_WINDOW_MS = 5 * 60_000;
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 400;

let sheetCache: CSSStyleSheet | null = null;

/**
 * The messenger UI inside a closed shadow root on a `<daykeeper-messenger>`
 * element. It renders `controller.state` and forwards visitor intents; it
 * keeps DOM for the composer, list rows and message rows across renders so
 * focus, selection and scroll position survive polling.
 */
export class MessengerView {
  readonly host: HTMLElement;
  readonly #doc: Document;
  readonly #win: Window;
  readonly #root: ShadowRoot;
  readonly #c: MessengerController;
  readonly #o: ViewOptions;
  readonly #t: Strings;

  // static skeleton
  #dk!: HTMLDivElement;
  #live!: HTMLDivElement;
  #panel!: HTMLElement;
  #back!: HTMLButtonElement;
  #monogram!: HTMLSpanElement;
  #title!: HTMLHeadingElement;
  #banner!: HTMLDivElement;
  #body!: HTMLDivElement;
  #jump!: HTMLButtonElement;
  #composer!: HTMLFormElement;
  #textarea!: HTMLTextAreaElement;
  #send!: HTMLButtonElement;
  #note!: HTMLParagraphElement;
  #launcher!: HTMLButtonElement;
  #badge!: HTMLSpanElement;

  // dynamic
  #screen: Screen = "none";
  #screenKey = "";
  #homeList: HTMLUListElement | null = null;
  #homeRows = new Map<number, HTMLLIElement>();
  #homeHero: HTMLHeadingElement | null = null;
  #homeListCard: HTMLDivElement | null = null;
  #threadIntro: HTMLDivElement | null = null;
  #threadMessages: HTMLDivElement | null = null;
  #msgRows = new Map<string, HTMLDivElement>();
  #wasOpen = false;
  #lastView = "";
  #returnFocus: Element | null = null;
  #clock: ReturnType<typeof setInterval> | null = null;
  #cleanup: (() => void)[] = [];
  #openCleanup: (() => void)[] = [];
  #mobile: MediaQueryList;
  #dark: MediaQueryList;
  #tooLong = false;

  constructor(
    doc: Document,
    controller: MessengerController,
    options: ViewOptions,
  ) {
    this.#doc = doc;
    this.#win = doc.defaultView ?? window;
    this.#c = controller;
    this.#o = options;
    this.#t = options.strings;
    this.host = doc.createElement("daykeeper-messenger");
    this.#root = this.host.attachShadow({ mode: "closed" });
    this.#mobile = this.#win.matchMedia(MOBILE_QUERY);
    this.#dark = this.#win.matchMedia("(prefers-color-scheme: dark)");
    this.#installStyles();
    this.#build();
  }

  mount(): void {
    (this.#doc.body ?? this.#doc.documentElement).append(this.host);
    const onTheme = () => this.#applyTheme();
    const onMobile = () => this.#syncMobile();
    this.#dark.addEventListener("change", onTheme);
    this.#mobile.addEventListener("change", onMobile);
    this.#cleanup.push(
      () => this.#dark.removeEventListener("change", onTheme),
      () => this.#mobile.removeEventListener("change", onMobile),
    );
    this.#applyTheme();
    this.render();
  }

  unmount(): void {
    this.#leaveOpen();
    for (const fn of this.#cleanup.splice(0)) fn();
    this.host.remove();
  }

  // ---- construction ---------------------------------------------------

  #installStyles(): void {
    const text = css.replace(
      "var(--dk-z, 2147483000)",
      String(Math.trunc(this.#o.zIndex)),
    );
    try {
      // Constructable sheets are not inline style under CSP, so they apply on
      // pages that forbid 'unsafe-inline' styles.
      const sheet =
        sheetCache && this.#o.zIndex === 2147483000
          ? sheetCache
          : new CSSStyleSheet();
      if (sheet !== sheetCache) {
        sheet.replaceSync(text);
        if (this.#o.zIndex === 2147483000) sheetCache = sheet;
      }
      this.#root.adoptedStyleSheets = [sheet];
    } catch {
      const style = this.#doc.createElement("style");
      style.textContent = text;
      this.#root.append(style);
    }
  }

  #build(): void {
    const d = this.#doc;
    const t = this.#t;
    this.#dk = h(d, "div", {
      class: "dk",
      "data-position": this.#o.position,
      "data-open": "false",
      "data-no-launcher": String(this.#o.hideLauncher),
    });
    this.#live = h(d, "div", {
      class: "sr",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    });

    this.#back = h(
      d,
      "button",
      { type: "button", class: "icon-button", "aria-label": t.back },
      icon(d, "back"),
    );
    this.#back.addEventListener("click", () => this.#c.showHome());
    this.#monogram = h(d, "span", {
      class: "monogram",
      "aria-hidden": "true",
    });
    this.#title = h(d, "h2", { class: "topbar-name", id: "dk-title" });
    const close = h(
      d,
      "button",
      { type: "button", class: "icon-button", "aria-label": t.close },
      icon(d, "close", 22),
    );
    close.addEventListener("click", () => this.#c.close());
    const topbar = h(
      d,
      "header",
      { class: "topbar" },
      this.#back,
      h(
        d,
        "div",
        { class: "topbar-title" },
        this.#monogram,
        h(d, "div", { style: null }, this.#title),
      ),
      close,
    );
    // The title wrapper needs min-width:0 for ellipsis; set via CSSOM.
    (this.#title.parentElement as HTMLElement).style.minWidth = "0";

    this.#banner = h(d, "div", { class: "banner", role: "status" });
    this.#banner.hidden = true;
    this.#body = h(d, "div", { class: "body", tabindex: "-1" });
    this.#body.addEventListener("scroll", () => this.#onScroll(), {
      passive: true,
    });
    this.#jump = h(
      d,
      "button",
      { type: "button", class: "jump" },
      t.newMessages,
      icon(d, "down", 16, "", 2.2),
    );
    this.#jump.hidden = true;
    this.#jump.addEventListener("click", () => this.#scrollToBottom(true));

    this.#textarea = h(d, "textarea", {
      rows: 1,
      "aria-label": t.composerLabel,
      placeholder: t.composerPlaceholder,
      autocomplete: "off",
      enterkeyhint: "send",
    });
    this.#send = h(
      d,
      "button",
      { type: "submit", class: "send", "aria-label": t.send, disabled: true },
      icon(d, "send", 20, "", 2.2),
    );
    this.#note = h(d, "p", { class: "composer-note", id: "dk-note" });
    this.#note.hidden = true;
    this.#composer = h(
      d,
      "form",
      { class: "composer", novalidate: true },
      h(d, "div", { class: "field" }, this.#textarea, this.#send),
      this.#note,
    );
    this.#composer.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submit();
    });
    this.#textarea.addEventListener("input", () => {
      this.#c.noteActivity();
      this.#syncComposer();
    });
    this.#textarea.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        this.#submit();
      }
    });

    this.#panel = h(
      d,
      "section",
      {
        class: "panel",
        id: "dk-panel",
        role: "dialog",
        "aria-labelledby": "dk-title",
      },
      topbar,
      this.#banner,
      h(d, "div", { class: "body-wrap" }, this.#body, this.#jump),
      this.#composer,
    );
    this.#panel.hidden = true;

    this.#badge = h(d, "span", { class: "badge", "aria-hidden": "true" });
    this.#badge.hidden = true;
    this.#launcher = h(
      d,
      "button",
      {
        type: "button",
        class: "launcher",
        "aria-controls": "dk-panel",
        "aria-expanded": "false",
        "aria-label": t.openMessenger,
      },
      icon(d, "chat", 28, "icon icon-chat", 1.9),
      icon(d, "down", 28, "icon icon-close", 2),
      this.#badge,
    );
    this.#launcher.hidden = this.#o.hideLauncher;
    this.#launcher.addEventListener("click", () => this.#c.toggle());

    this.#dk.append(this.#live, this.#panel, this.#launcher);
    this.#dk.addEventListener("keydown", (event) => this.#onKeydown(event));
    this.#root.append(this.#dk);
  }

  // ---- rendering ------------------------------------------------------

  render(): void {
    const s = this.#c.state;
    this.#renderLauncher(s);
    this.#renderChrome(s);
    this.#renderScreen(s);
    this.#renderOpenState(s);
  }

  announce(messages: ThreadMessage[]): void {
    const last = messages[messages.length - 1];
    if (!last) return;
    const name = this.#nameFor(last);
    const text =
      last.content.length > 160
        ? `${last.content.slice(0, 157)}…`
        : last.content;
    this.#live.textContent = "";
    // A fresh text node after clearing makes screen readers re-announce.
    this.#win.setTimeout(() => {
      this.#live.textContent = this.#t.newMessageFrom(name, text);
    }, 60);
  }

  #renderLauncher(s: MessengerState): void {
    const t = this.#t;
    this.#launcher.setAttribute("aria-expanded", String(s.open));
    const label = s.open ? t.closeMessenger : t.openMessenger;
    this.#launcher.setAttribute(
      "aria-label",
      s.unread > 0 && !s.open ? `${label}, ${t.unreadCount(s.unread)}` : label,
    );
    const showBadge = s.unread > 0 && !s.open;
    const text = s.unread > 9 ? "9+" : String(s.unread);
    if (this.#badge.textContent !== text) this.#badge.textContent = text;
    this.#badge.hidden = !showBadge;
  }

  #renderChrome(s: MessengerState): void {
    const name = s.inbox?.name ?? "";
    this.#title.textContent = name;
    this.#monogram.textContent = initial(name || "D");
    this.#monogram.hidden = !name;
    const inThread =
      s.view === "thread" && s.phase !== "error" && s.phase !== "connecting";
    this.#panel.classList.toggle("view-thread", inThread);
    this.#back.hidden = !(s.view === "thread");
    this.#composer.hidden = !inThread;
    this.#banner.hidden = !(s.degraded && s.phase === "ready");
    if (!this.#banner.hidden) this.#banner.textContent = this.#t.errors.offline;
    if (s.inbox?.accentColor) {
      this.#dk.style.setProperty("--accent", s.inbox.accentColor);
      this.#dk.style.setProperty("--on-accent", onColor(s.inbox.accentColor));
    }
  }

  #renderScreen(s: MessengerState): void {
    if (s.phase === "error" && s.error) {
      this.#showState(s.error);
      return;
    }
    if (s.phase !== "ready" || !s.inbox) {
      this.#showLoading(s.view);
      return;
    }
    if (s.view === "home") this.#renderHome(s);
    else this.#renderThread(s);
  }

  #setScreen(screen: Screen, key: string): boolean {
    if (this.#screen === screen && this.#screenKey === key) return false;
    this.#screen = screen;
    this.#screenKey = key;
    this.#body.replaceChildren();
    this.#homeList = null;
    this.#homeRows.clear();
    this.#homeHero = null;
    this.#homeListCard = null;
    this.#threadIntro = null;
    this.#threadMessages = null;
    this.#msgRows.clear();
    this.#jump.hidden = true;
    return true;
  }

  #showLoading(view: string): void {
    if (!this.#setScreen("loading", view)) return;
    const d = this.#doc;
    const wrap = h(d, "div", {
      class: "skeleton",
      role: "progressbar",
      "aria-label": this.#t.loading,
      "aria-busy": "true",
    });
    if (view === "home") {
      wrap.append(
        h(d, "div", { class: "skel", style: null }),
        h(d, "div", { class: "skel" }),
        h(d, "div", { class: "skel block" }),
        h(d, "div", { class: "skel block" }),
      );
      const [a, b] = Array.from(wrap.children) as HTMLElement[];
      a!.style.cssText = "height:30px;width:70%;margin-top:22px";
      b!.style.cssText = "height:30px;width:45%;margin-bottom:12px";
    } else {
      for (const width of ["62%", "48%", "70%"]) {
        const line = h(d, "div", { class: "skel" });
        line.style.cssText = `height:40px;width:${width};border-radius:18px`;
        wrap.append(line);
      }
      const mine = wrap.children[1] as HTMLElement;
      mine.style.alignSelf = "flex-end";
    }
    this.#body.append(wrap);
  }

  #showState(code: MessengerErrorCode): void {
    if (!this.#setScreen("state", code)) return;
    const d = this.#doc;
    const e = this.#t.errors;
    let title = e.genericTitle;
    let body = e.genericBody;
    let glyph: "alert" | "offline" | "pause" = "alert";
    let retry = true;
    if (code === "web_client_unavailable" || code === "web_client_disabled") {
      title = e.unavailableTitle;
      body = e.unavailableBody;
      glyph = "pause";
      retry = false;
    } else if (code === "origin_not_allowed") {
      title = e.notSetUpTitle;
      body = e.notSetUpBody;
      retry = false;
    } else if (code === "network_error" || code === "temporarily_unavailable") {
      title = e.connectionTitle;
      body = e.connectionBody;
      glyph = "offline";
    }
    const wrap = h(
      d,
      "div",
      { class: "state", role: "alert" },
      h(d, "div", { class: "state-icon" }, icon(d, glyph, 26)),
      h(d, "h3", { class: "state-title" }, title),
      h(d, "p", { class: "state-body" }, body),
    );
    if (retry) {
      const button = h(
        d,
        "button",
        { type: "button", class: "pill" },
        e.tryAgain,
      );
      button.addEventListener("click", () => this.#c.retry());
      wrap.append(button);
    }
    this.#body.append(wrap);
  }

  // ---- home -----------------------------------------------------------

  #renderHome(s: MessengerState): void {
    const d = this.#doc;
    const t = this.#t;
    if (this.#setScreen("home", "")) {
      this.#homeHero = h(d, "h3", { class: "hero-title" });
      const start = h(
        d,
        "button",
        { type: "button", class: "pill", "data-primary": "" },
        t.newConversation,
        icon(d, "send", 18, "", 2.2),
      );
      (start.lastChild as SVGElement).style.transform = "rotate(90deg)";
      start.addEventListener("click", () => this.#c.newConversation());
      const startCard = h(
        d,
        "div",
        { class: "card start" },
        h(d, "p", { class: "card-title" }, t.startTitle),
        h(d, "p", { class: "card-body" }, t.startBody),
        start,
      );
      this.#homeList = h(d, "ul", { class: "list" });
      this.#homeListCard = h(
        d,
        "div",
        { class: "card list-card" },
        h(
          d,
          "h4",
          { class: "list-heading", id: "dk-list" },
          t.yourConversations,
        ),
        this.#homeList,
      );
      this.#homeList.setAttribute("aria-labelledby", "dk-list");
      const footer = h(d, "p", { class: "footer" });
      const link = h(
        d,
        "a",
        {
          href: poweredByUrl(this.#win.location.hostname),
          target: "_blank",
          rel: "noopener noreferrer",
        },
        t.poweredBy,
      );
      footer.append(link);
      this.#body.append(
        h(
          d,
          "div",
          { class: "home" },
          h(d, "div", { class: "hero" }, this.#homeHero),
          startCard,
          this.#homeListCard,
          footer,
        ),
      );
      this.#body.scrollTop = 0;
    }
    const greeting = s.inbox?.greeting ?? t.defaultGreeting;
    this.#homeHero!.textContent = greeting;
    this.#homeHero!.classList.toggle("long", greeting.length > 70);
    this.#homeListCard!.hidden = s.conversations.length === 0;
    this.#syncRows(s.conversations);
  }

  #syncRows(conversations: ConversationSummary[]): void {
    const list = this.#homeList!;
    const seen = new Set<number>();
    const now = Date.now();
    const name = this.#c.state.inbox?.name ?? "";
    conversations.forEach((entry, index) => {
      seen.add(entry.id);
      let li = this.#homeRows.get(entry.id);
      if (!li) {
        li = this.#buildRow(entry.id);
        this.#homeRows.set(entry.id, li);
      }
      const button = li.firstElementChild as HTMLButtonElement;
      const preview = button.querySelector(".row-preview")!;
      const meta = button.querySelector(".row-meta")!;
      const dot = button.querySelector(".dot") as HTMLElement;
      const monogram = button.querySelector(".monogram")!;
      monogram.textContent = initial(name || "D");
      preview.textContent =
        entry.preview ?? this.#t.conversationFallbackPreview;
      const when = relativeTime(entry.updatedAt, now, this.#o.locale);
      meta.textContent = when ? `${name} · ${when}` : name;
      button.classList.toggle("unread", entry.unread > 0);
      dot.hidden = entry.unread === 0;
      button.setAttribute(
        "aria-label",
        [
          entry.preview ?? this.#t.conversationFallbackPreview,
          when,
          entry.unread > 0 ? this.#t.unreadCount(entry.unread) : "",
        ]
          .filter(Boolean)
          .join(", "),
      );
      if (list.children[index] !== li)
        list.insertBefore(li, list.children[index] ?? null);
    });
    for (const [id, li] of this.#homeRows) {
      if (!seen.has(id)) {
        li.remove();
        this.#homeRows.delete(id);
      }
    }
  }

  #buildRow(id: number): HTMLLIElement {
    const d = this.#doc;
    const dot = h(d, "span", { class: "dot", "aria-hidden": "true" });
    const button = h(
      d,
      "button",
      { type: "button", class: "row", "data-conversation": id },
      h(d, "span", { class: "monogram", "aria-hidden": "true" }),
      h(
        d,
        "span",
        { class: "row-main" },
        h(d, "span", { class: "row-preview" }),
        h(d, "span", { class: "row-meta" }),
      ),
      dot,
      icon(d, "next", 18, "chev"),
    );
    button.addEventListener("click", () => this.#c.openConversation(id));
    return h(d, "li", {}, button);
  }

  // ---- thread ---------------------------------------------------------

  #renderThread(s: MessengerState): void {
    const d = this.#doc;
    const key = `thread:${s.activeId ?? "new"}`;
    let fresh: boolean;
    if (
      this.#screen === "thread" &&
      this.#screenKey === "thread:new" &&
      s.activeId !== null
    ) {
      // The first send just created this conversation: keep the DOM.
      this.#screenKey = key;
      fresh = false;
    } else {
      fresh = this.#setScreen("thread", key);
    }
    if (fresh) {
      const name = s.inbox?.name ?? "";
      this.#threadIntro = h(
        d,
        "div",
        { class: "intro" },
        h(
          d,
          "span",
          { class: "monogram large", "aria-hidden": "true" },
          initial(name || "D"),
        ),
        h(d, "p", { class: "intro-name" }, name),
        h(
          d,
          "p",
          { class: "intro-greeting" },
          s.inbox?.greeting ?? this.#t.defaultGreeting,
        ),
      );
      this.#threadMessages = h(d, "div", {
        class: "messages",
        role: "log",
        "aria-label": name,
      });
      this.#body.append(
        h(
          d,
          "div",
          { class: "thread" },
          this.#threadIntro,
          this.#threadMessages,
        ),
      );
      const prefill = this.#c.consumePrefill();
      if (prefill !== null) {
        this.#textarea.value = prefill.slice(0, MAX_MESSAGE_LENGTH);
      } else if (this.#lastView !== key) {
        this.#textarea.value = "";
      }
      this.#syncComposer();
    }
    this.#lastView = key;

    if (!s.threadLoaded) {
      if (!this.#threadMessages!.querySelector(".skel")) {
        for (const [width, mine] of [
          ["58%", false],
          ["40%", true],
        ] as const) {
          const line = h(d, "div", { class: "skel" });
          line.style.cssText = `height:40px;width:${width};border-radius:18px;margin-top:14px${mine ? ";align-self:flex-end" : ""}`;
          this.#threadMessages!.append(line);
        }
      }
      return;
    }
    for (const skel of Array.from(
      this.#threadMessages!.querySelectorAll(".skel"),
    )) {
      skel.remove();
    }

    const stick = fresh || this.#atBottom();
    const added = this.#syncMessages(s.thread);
    if (stick) this.#scrollToBottom(false);
    else if (added.some((entry) => entry.author !== "customer"))
      this.#jump.hidden = false;
    if (fresh)
      this.#win.requestAnimationFrame(() => this.#scrollToBottom(false));
  }

  #syncMessages(thread: ThreadMessage[]): ThreadMessage[] {
    const container = this.#threadMessages!;
    const now = Date.now();
    const added: ThreadMessage[] = [];
    const seen = new Set<string>();
    thread.forEach((message, index) => {
      seen.add(message.key);
      let row = this.#msgRows.get(message.key);
      // A pending send settles into a server message with a new key; reuse
      // its row so the bubble does not flicker.
      if (!row && message.id !== null && message.author === "customer") {
        for (const [key, candidate] of this.#msgRows) {
          if (
            key.startsWith("p:") &&
            !thread.some((entry) => entry.key === key) &&
            candidate.dataset.content === message.content
          ) {
            this.#msgRows.delete(key);
            this.#msgRows.set(message.key, candidate);
            row = candidate;
            break;
          }
        }
      }
      if (!row) {
        row = this.#buildMessage(message);
        this.#msgRows.set(message.key, row);
        added.push(message);
      }
      const previous = thread[index - 1];
      const next = thread[index + 1];
      const first = !previous || !sameGroup(previous, message);
      const last = !next || !sameGroup(message, next);
      this.#updateMessage(row, message, first, last, now);
      if (container.children[index] !== row) {
        container.insertBefore(row, container.children[index] ?? null);
      }
    });
    for (const [key, row] of this.#msgRows) {
      if (!seen.has(key)) {
        row.remove();
        this.#msgRows.delete(key);
      }
    }
    return added;
  }

  #buildMessage(message: ThreadMessage): HTMLDivElement {
    const d = this.#doc;
    if (message.author === "system") {
      const row = h(d, "div", { class: "system" });
      row.append(renderRichText(d, message.content));
      return row;
    }
    const me = message.author === "customer";
    const author = h(d, "div", { class: "author" });
    if (!me) {
      const name = this.#nameFor(message);
      author.append(
        message.author === "agent"
          ? h(
              d,
              "span",
              { class: "monogram small", "aria-hidden": "true" },
              initial(name),
            )
          : h(
              d,
              "span",
              { class: "monogram small person", "aria-hidden": "true" },
              initials(name),
            ),
        h(d, "span", { class: "author-name" }, name),
      );
      if (message.author === "agent") {
        author.append(
          h(
            d,
            "span",
            { class: "tag" },
            icon(d, "sparkle", 11),
            this.#t.aiAgent,
          ),
        );
      }
    }
    const bubble = h(d, "div", { class: "bubble" });
    bubble.append(renderRichText(d, message.content));
    const meta = h(d, "div", { class: "meta" });
    const row = h(
      d,
      "div",
      { class: `msg${me ? " me" : ""}` },
      author,
      bubble,
      meta,
    );
    row.dataset.content = message.content;
    return row;
  }

  #updateMessage(
    row: HTMLDivElement,
    message: ThreadMessage,
    first: boolean,
    last: boolean,
    now: number,
  ): void {
    if (message.author === "system") return;
    const me = message.author === "customer";
    row.classList.toggle("first", first);
    row.classList.toggle("last", last);
    row.classList.toggle(
      "pending",
      message.status === "sending" || message.status === "unconfirmed",
    );
    row.classList.toggle("failed", message.status === "failed");
    const author = row.children[0] as HTMLElement;
    author.hidden = !first || me;
    const meta = row.children[2] as HTMLElement;
    const t = this.#t;
    meta.classList.remove("error");
    if (message.status === "failed") {
      meta.hidden = false;
      meta.classList.add("error");
      const reason =
        message.failure === "limited"
          ? t.errors.sendLimited
          : message.failure === "tooLong"
            ? t.tooLong(MAX_MESSAGE_LENGTH)
            : message.failure === "unknown"
              ? t.maybeNotDelivered
              : t.notDelivered;
      const key = message.key;
      const children: Node[] = [d(this.#doc, reason)];
      if (message.failure !== "limited" && message.failure !== "tooLong") {
        const retry = h(
          this.#doc,
          "button",
          { type: "button", class: "link-button" },
          t.retry,
        );
        retry.addEventListener("click", () => void this.#c.retrySend(key));
        children.push(retry);
      }
      meta.replaceChildren(...children);
      return;
    }
    if (message.status === "sending" || message.status === "unconfirmed") {
      meta.hidden = !last;
      meta.replaceChildren(d(this.#doc, t.sending));
      return;
    }
    meta.hidden = !last;
    if (!last) return;
    const when = relativeTime(
      message.createdAt,
      now,
      this.#o.locale,
      t.justNow,
    );
    const time = h(
      this.#doc,
      "time",
      {
        title: absoluteTime(message.createdAt, this.#o.locale),
        datetime: message.createdAt
          ? new Date(message.createdAt).toISOString()
          : null,
      },
      when,
    );
    meta.replaceChildren(...(me ? [d(this.#doc, `${t.you} ·`), time] : [time]));
  }

  #nameFor(message: ThreadMessage): string {
    if (message.author === "customer") return this.#t.you;
    if (message.senderName) return message.senderName;
    if (message.author === "agent")
      return this.#c.state.inbox?.name ?? this.#t.teamMember;
    return this.#t.teamMember;
  }

  #atBottom(): boolean {
    const b = this.#body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
  }

  #scrollToBottom(smooth: boolean): void {
    const reduce = this.#win.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.#body.scrollTo({
      top: this.#body.scrollHeight,
      behavior: smooth && !reduce ? "smooth" : "auto",
    });
    this.#jump.hidden = true;
  }

  #onScroll(): void {
    if (!this.#jump.hidden && this.#atBottom()) this.#jump.hidden = true;
    this.#c.noteActivity();
  }

  // ---- composer -------------------------------------------------------

  #syncComposer(): void {
    const value = this.#textarea.value;
    const length = value.trim().length;
    this.#tooLong = length > MAX_MESSAGE_LENGTH;
    this.#send.disabled = length === 0 || this.#tooLong;
    const t = this.#t;
    if (this.#tooLong) {
      this.#note.hidden = false;
      this.#note.className = "composer-note error";
      this.#note.textContent = t.tooLong(MAX_MESSAGE_LENGTH);
      this.#textarea.setAttribute("aria-describedby", "dk-note");
      this.#textarea.setAttribute("aria-invalid", "true");
    } else if (length >= COUNTER_FROM) {
      this.#note.hidden = false;
      this.#note.className = "composer-note";
      this.#note.textContent = t.charactersLeft(MAX_MESSAGE_LENGTH - length);
      this.#textarea.setAttribute("aria-describedby", "dk-note");
      this.#textarea.removeAttribute("aria-invalid");
    } else {
      this.#note.hidden = true;
      this.#textarea.removeAttribute("aria-describedby");
      this.#textarea.removeAttribute("aria-invalid");
    }
    // Auto-grow up to the CSS max-height.
    this.#textarea.style.height = "auto";
    this.#textarea.style.height = `${Math.min(this.#textarea.scrollHeight, 140)}px`;
  }

  #submit(): void {
    const value = this.#textarea.value.trim();
    if (!value || value.length > MAX_MESSAGE_LENGTH) return;
    this.#textarea.value = "";
    this.#syncComposer();
    void this.#c.send(value);
    this.#win.requestAnimationFrame(() => this.#scrollToBottom(true));
  }

  // ---- open / close, focus, mobile ------------------------------------

  #renderOpenState(s: MessengerState): void {
    this.#dk.dataset.open = String(s.open);
    const opening = s.open && !this.#wasOpen;
    const closing = !s.open && this.#wasOpen;
    this.#wasOpen = s.open;
    this.#panel.hidden = !s.open;
    if (opening) this.#enterOpen();
    if (closing) this.#leaveOpen(true);
    // Move focus when the panel opens, the view changes, or content replaces
    // a loading/error screen -- never on a poll, and never away from the
    // composer when a first send assigns the conversation its id.
    const bucket =
      s.phase === "ready" ? "ready" : s.phase === "error" ? "error" : "";
    const focusKey = bucket ? `${s.view}:${bucket}` : "";
    if (s.open && focusKey && (opening || focusKey !== this.#focusKey)) {
      this.#win.requestAnimationFrame(() => this.#focusForView(this.#c.state));
    }
    this.#focusKey = s.open ? focusKey || this.#focusKey : "";
  }

  #focusKey = "";

  #focusForView(s: MessengerState): void {
    if (!this.#c.state.open) return;
    const mobile = this.#mobile.matches;
    if (s.phase === "error") {
      (this.#body.querySelector("button") ?? this.#body).focus();
      return;
    }
    if (s.view === "thread" && s.phase === "ready") {
      if (!mobile) this.#textarea.focus();
      else this.#back.focus();
      return;
    }
    const primary = this.#body.querySelector<HTMLElement>("[data-primary]");
    if (primary && !mobile) primary.focus();
    else
      this.#panel
        .querySelector<HTMLElement>(".icon-button:not([hidden])")
        ?.focus();
  }

  #enterOpen(): void {
    const active = this.#doc.activeElement;
    this.#returnFocus = active && active !== this.host ? active : null;
    this.#syncMobile();
    this.#clock = setInterval(() => this.#refreshTimes(), 30_000);
  }

  #leaveOpen(restoreFocus = false): void {
    if (this.#clock) clearInterval(this.#clock);
    this.#clock = null;
    for (const fn of this.#openCleanup.splice(0)) fn();
    this.#panel.removeAttribute("aria-modal");
    if (restoreFocus) {
      if (!this.#o.hideLauncher) this.#launcher.focus();
      else if (this.#returnFocus instanceof HTMLElement)
        this.#returnFocus.focus();
    }
  }

  #syncMobile(): void {
    for (const fn of this.#openCleanup.splice(0)) fn();
    if (!this.#c.state.open) return;
    const mobile = this.#mobile.matches;
    // Modal (focus-trapped, page scroll locked) on phones; non-modal beside
    // the page on larger screens.
    if (mobile) this.#panel.setAttribute("aria-modal", "true");
    else this.#panel.removeAttribute("aria-modal");
    if (!mobile) return;
    const html = this.#doc.documentElement;
    const body = this.#doc.body;
    const saved = [html.style.overflow, body?.style.overflow ?? ""];
    html.style.setProperty("overflow", "hidden", "important");
    body?.style.setProperty("overflow", "hidden", "important");
    this.#openCleanup.push(() => {
      html.style.overflow = saved[0]!;
      if (body) body.style.overflow = saved[1]!;
    });
    const vv = this.#win.visualViewport;
    if (vv) {
      const sync = () => {
        this.#dk.style.setProperty("--vvh", `${vv.height}px`);
        this.#dk.style.setProperty("--vvtop", `${vv.offsetTop}px`);
        if (this.#atBottom()) this.#scrollToBottom(false);
      };
      sync();
      vv.addEventListener("resize", sync);
      vv.addEventListener("scroll", sync);
      this.#openCleanup.push(() => {
        vv.removeEventListener("resize", sync);
        vv.removeEventListener("scroll", sync);
        this.#dk.style.removeProperty("--vvh");
        this.#dk.style.removeProperty("--vvtop");
      });
    }
  }

  #onKeydown(event: KeyboardEvent): void {
    if (!this.#c.state.open) return;
    if (event.key === "Escape" && !event.isComposing) {
      event.stopPropagation();
      this.#c.close();
      return;
    }
    if (event.key !== "Tab" || !this.#mobile.matches) return;
    const focusable = Array.from(
      this.#panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter(
      (element) =>
        !element.closest("[hidden]") && element.getClientRects().length > 0,
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = this.#root.activeElement;
    if (event.shiftKey && (active === first || !this.#panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !this.#panel.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  #refreshTimes(): void {
    const s = this.#c.state;
    if (s.view === "home" && this.#homeList) this.#syncRows(s.conversations);
    if (s.view === "thread" && this.#threadMessages && s.threadLoaded) {
      this.#syncMessages(s.thread);
    }
  }

  #applyTheme(): void {
    const dark =
      this.#o.theme === "dark" ||
      (this.#o.theme === "auto" && this.#dark.matches);
    this.#dk.dataset.theme = dark ? "dark" : "light";
  }
}

function d(doc: Document, text: string): Text {
  return doc.createTextNode(text);
}

function sameGroup(a: ThreadMessage, b: ThreadMessage): boolean {
  if (a.author === "system" || b.author === "system") return false;
  if (a.author !== b.author) return false;
  if (a.author !== "customer" && a.senderName !== b.senderName) return false;
  if (
    a.createdAt !== null &&
    b.createdAt !== null &&
    b.createdAt - a.createdAt > GROUP_WINDOW_MS
  )
    return false;
  return true;
}
