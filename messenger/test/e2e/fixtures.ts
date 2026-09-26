import { test as base, expect, type Page } from "@playwright/test";
import { startMock, type Mock } from "../../mock/server.mjs";

export { expect };

/**
 * The messenger uses a closed shadow root. Most tests open it (test-only init
 * script) so Playwright locators and axe can see inside; the isolation tests
 * run without this and drive the page by coordinates and keyboard only.
 */
export const openShadowRoots = () => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    return attach.call(this, { ...init, mode: "open" });
  };
};

export const test = base.extend<{ mock: Mock }>({
  mock: async ({}, use) => {
    const mock = await startMock();
    await use(mock);
    await mock.close();
  },
});

export function messenger(page: Page) {
  const host = page.locator("daykeeper-messenger");
  return {
    host,
    launcher: host.locator(".launcher"),
    badge: host.locator(".badge"),
    panel: host.locator(".panel"),
    textarea: host.locator("textarea"),
    newConversation: host.locator("[data-primary]"),
    back: host.locator(".topbar .icon-button").first(),
    close: host.getByRole("button", { name: "Close", exact: true }),
    messages: host.locator(".messages"),
    live: host.locator("[aria-live]"),
  };
}

export async function storeVisitor(
  page: Page,
  key: string,
  visitor: { visitorId: string; secret: string; hasConversation: boolean },
) {
  await page.addInitScript(
    ([storageKey, value]) => {
      try {
        if (!sessionStorage.getItem("dk-test-seeded")) {
          localStorage.setItem(storageKey!, value!);
          sessionStorage.setItem("dk-test-seeded", "1");
        }
      } catch {
        /* ignore */
      }
    },
    [`dk:messenger:${key}`, JSON.stringify(visitor)],
  );
}

export async function waitForRequest(
  mock: Mock,
  predicate: (entry: { method: string; path: string }) => boolean,
  timeout = 15_000,
) {
  const started = Date.now();
  for (;;) {
    const { requests } = await mock.state();
    const found = requests.filter(predicate);
    if (found.length) return found;
    if (Date.now() - started > timeout) throw new Error("request never seen");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
