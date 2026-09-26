import { MessengerController } from "./controller.ts";
import { VisitorSession } from "./session.ts";
import { createVisitorStore } from "./storage.ts";
import { stringsFor } from "./strings.ts";
import { MessengerView } from "./view.ts";

/**
 * Daykeeper Messenger loader. The page's snippet defines a queueing stub:
 *
 *   window.Daykeeper = window.Daykeeper || function () {
 *     (Daykeeper.q = Daykeeper.q || []).push(arguments) };
 *   Daykeeper('boot', { publishableKey: 'dk_pk_…' });
 *
 * This script replaces the stub with the real function and replays the queue.
 * `window.Daykeeper` is the only global it defines.
 */

declare const __MESSENGER_VERSION__: string;

export const VERSION =
  typeof __MESSENGER_VERSION__ === "string" ? __MESSENGER_VERSION__ : "dev";
export const DEFAULT_GATEWAY_URL = "https://gateway.mydaykeeper.com";
const PUBLISHABLE_KEY = /^dk_pk_[A-Za-z0-9]{32}$/;
const EVENTS = ["ready", "open", "close", "unreadCountChange"] as const;
type EventName = (typeof EVENTS)[number];
type Callback = (value?: unknown) => void;

export interface BootOptions {
  publishableKey: string;
  gatewayUrl?: string;
  locale?: string;
  theme?: "auto" | "light" | "dark";
  position?: "right" | "left";
  hideLauncher?: boolean;
  zIndex?: number;
}

interface Instance {
  controller: MessengerController;
  view: MessengerView;
  store: ReturnType<typeof createVisitorStore>;
  cleanup: () => void;
}

function warn(message: string): void {
  try {
    console.warn(`[Daykeeper Messenger] ${message}`);
  } catch {
    /* console may be unavailable */
  }
}

/** Parse and validate `boot` options; null (with a console warning) if unusable. */
export function parseBootOptions(
  raw: unknown,
):
  | (Required<Omit<BootOptions, "locale">> & { locale: string | undefined })
  | null {
  if (!raw || typeof raw !== "object") {
    warn("boot needs an options object with a publishableKey.");
    return null;
  }
  const options = raw as Record<string, unknown>;
  if (
    typeof options.publishableKey !== "string" ||
    !PUBLISHABLE_KEY.test(options.publishableKey)
  ) {
    warn("boot needs a valid publishableKey (dk_pk_…).");
    return null;
  }
  const gatewayUrl = normalizeGatewayUrl(
    options.gatewayUrl === undefined ? DEFAULT_GATEWAY_URL : options.gatewayUrl,
  );
  if (!gatewayUrl) {
    warn(
      "gatewayUrl must be an https URL (or http on loopback) without a query.",
    );
    return null;
  }
  const locale =
    typeof options.locale === "string" &&
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(options.locale)
      ? options.locale
      : typeof navigator !== "undefined" && navigator.language
        ? navigator.language
        : undefined;
  const zIndex =
    typeof options.zIndex === "number" &&
    Number.isInteger(options.zIndex) &&
    options.zIndex >= 0 &&
    options.zIndex <= 2147483647
      ? options.zIndex
      : 2147483000;
  return {
    publishableKey: options.publishableKey,
    gatewayUrl,
    locale,
    theme:
      options.theme === "light" || options.theme === "dark"
        ? options.theme
        : "auto",
    position: options.position === "left" ? "left" : "right",
    hideLauncher: options.hideLauncher === true,
    zIndex,
  };
}

export function normalizeGatewayUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}

export function createMessengerApi(win: Window & typeof globalThis) {
  const listeners = new Map<EventName, Set<Callback>>(
    EVENTS.map((name) => [name, new Set<Callback>()]),
  );
  let instance: Instance | null = null;
  let ready = false;

  const emit = (name: EventName, value?: unknown) => {
    for (const callback of listeners.get(name) ?? []) {
      try {
        callback(value);
      } catch (error) {
        // Host callbacks must not break the messenger; surface for debugging.
        win.setTimeout(() => {
          throw error;
        });
      }
    }
  };

  const shutdown = (options?: unknown) => {
    if (!instance) return;
    const forget =
      !!options &&
      typeof options === "object" &&
      (options as Record<string, unknown>).forget === true;
    instance.cleanup();
    instance.controller.shutdown();
    instance.view.unmount();
    if (forget) instance.store.clear();
    instance = null;
    ready = false;
  };

  const boot = (raw: unknown) => {
    const options = parseBootOptions(raw);
    if (!options) return;
    shutdown();
    const store = createVisitorStore(
      options.publishableKey,
      () => win.localStorage,
    );
    const session = new VisitorSession({
      publishableKey: options.publishableKey,
      gatewayUrl: options.gatewayUrl,
      locale: options.locale,
      store,
    });
    const controller = new MessengerController({ session, store });
    const view = new MessengerView(win.document, controller, {
      theme: options.theme,
      position: options.position,
      hideLauncher: options.hideLauncher,
      zIndex: options.zIndex,
      locale: options.locale,
      strings: stringsFor(options.locale),
    });
    let wasOpen = false;
    let hinted = false;
    controller.on((event) => {
      if (event.type === "change") {
        view.render();
        const { open, phase, error } = controller.state;
        if (open !== wasOpen) {
          wasOpen = open;
          emit(open ? "open" : "close");
        }
        if (phase === "error" && error === "network_error" && !hinted) {
          hinted = true;
          warn(
            `Could not reach ${options.gatewayUrl}. If this persists, check that ${win.location.origin} is an allowed website for this publishable key.`,
          );
        }
        if (phase === "error" && error === "origin_not_allowed" && !hinted) {
          hinted = true;
          warn(
            `${win.location.origin} is not an allowed website for this publishable key.`,
          );
        }
      } else if (event.type === "incoming") {
        view.announce(event.messages);
      } else if (event.type === "unread") {
        emit("unreadCountChange", event.count);
      }
    });
    const onVisibility = () => controller.visibilityChanged();
    win.document.addEventListener("visibilitychange", onVisibility);
    const mount = () => {
      view.mount();
      controller.start();
      ready = true;
      emit("ready");
    };
    let pending: (() => void) | null = null;
    if (win.document.body) mount();
    else {
      pending = () => {
        pending = null;
        if (instance?.view === view) mount();
      };
      win.document.addEventListener("DOMContentLoaded", pending, {
        once: true,
      });
    }
    instance = {
      controller,
      view,
      store,
      cleanup: () => {
        win.document.removeEventListener("visibilitychange", onVisibility);
        if (pending)
          win.document.removeEventListener("DOMContentLoaded", pending);
      },
    };
  };

  const requireInstance = (command: string): Instance | null => {
    if (!instance) warn(`"${command}" was called before "boot".`);
    return instance;
  };

  return function Daykeeper(command: unknown, ...args: unknown[]): unknown {
    switch (command) {
      case "boot":
        return boot(args[0]);
      case "shutdown":
        return shutdown(args[0]);
      case "show":
        return requireInstance(command)?.controller.open();
      case "hide":
        return requireInstance(command)?.controller.close();
      case "toggle":
        return requireInstance(command)?.controller.toggle();
      case "showNewMessage": {
        const text = typeof args[0] === "string" ? args[0] : null;
        return requireInstance(command)?.controller.newConversation(text);
      }
      case "on": {
        const [name, callback] = args;
        if (
          typeof callback !== "function" ||
          !EVENTS.includes(name as EventName)
        ) {
          warn(`"on" needs one of ${EVENTS.join(", ")} and a function.`);
          return undefined;
        }
        const set = listeners.get(name as EventName)!;
        set.add(callback as Callback);
        if (name === "ready" && ready) {
          queueMicrotask(() => (callback as Callback)());
        }
        return () => set.delete(callback as Callback);
      }
      default:
        warn(`Unknown command ${JSON.stringify(String(command))}.`);
        return undefined;
    }
  };
}

type Global = Window &
  typeof globalThis & {
    Daykeeper?: ((...args: unknown[]) => unknown) & {
      q?: ArrayLike<unknown>[];
      version?: string;
    };
  };

export function install(win: Global): void {
  const existing = win.Daykeeper;
  if (existing && existing.version) return; // already loaded
  const queued =
    existing && Array.isArray(existing.q) ? existing.q.slice() : [];
  const api = createMessengerApi(win) as NonNullable<Global["Daykeeper"]>;
  Object.defineProperty(api, "version", { value: VERSION, enumerable: true });
  win.Daykeeper = api;
  for (const entry of queued) {
    try {
      api(...Array.from(entry));
    } catch (error) {
      win.setTimeout(() => {
        throw error;
      });
    }
  }
}
