import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  expect,
  messenger,
  openShadowRoots,
  storeVisitor,
  test,
  waitForRequest,
} from "./fixtures.ts";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

test.describe("open, send, receive", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(openShadowRoots);
  });

  test("nothing is minted until the panel opens", async ({ page, mock }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await expect(m.launcher).toBeVisible();
    await expect(m.launcher).toHaveAttribute("aria-expanded", "false");
    await expect(m.launcher).toHaveAttribute("aria-controls", "dk-panel");
    await page.waitForTimeout(1_000);
    expect((await mock.state()).requests).toEqual([]);

    await m.launcher.click();
    await expect(m.panel).toBeVisible();
    await expect(m.panel).toHaveAttribute("role", "dialog");
    await expect(m.panel).not.toHaveAttribute("aria-modal", "true");
    await expect(m.launcher).toHaveAttribute("aria-expanded", "true");
    await expect(m.host.locator(".hero-title")).toHaveText(
      "Hi there. Ask us anything about your order, sizing or returns.",
    );
    const state = await mock.state();
    expect(state.visitors).toHaveLength(1);
    const stored = await page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem(`dk:messenger:${key}`) ?? "null"),
      mock.publishableKey,
    );
    expect(stored).toEqual({
      visitorId: state.visitors[0],
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      hasConversation: false,
    });
    // Opening the panel lists conversations but never creates one.
    expect(state.conversations).toHaveLength(0);
  });

  test("sends, then renders AI-agent, human and system replies", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await expect(m.textarea).toBeFocused();
    await m.textarea.fill("Hi! Do you ship to Canada?");
    await m.textarea.press("Enter");
    await expect(m.messages.locator(".msg.me .bubble")).toHaveText(
      "Hi! Do you ship to Canada?",
    );
    await expect(m.messages.locator(".msg.me .meta")).toContainText("You");
    await expect(m.textarea).toHaveValue("");

    const state = await mock.state();
    expect(state.conversations[0]!.messages.map((x) => x.content)).toEqual([
      "Hi! Do you ship to Canada?",
    ]);
    expect(
      await page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(`dk:messenger:${key}`)!)
            .hasConversation,
        mock.publishableKey,
      ),
    ).toBe(true);

    await mock.reply({
      author: "agent",
      content: "Yes! Orders over **$150** ship free.",
    });
    const agent = m.messages.locator(".msg").nth(1);
    await expect(agent.locator(".bubble")).toHaveText(
      "Yes! Orders over $150 ship free.",
    );
    await expect(agent.locator(".bubble strong")).toHaveText("$150");
    await expect(agent.locator(".author-name")).toHaveText("Fern");
    await expect(agent.locator(".tag")).toHaveText("AI agent");
    await expect(m.live).toHaveText(
      "Fern: Yes! Orders over **$150** ship free.",
    );

    await mock.reply({
      author: "system",
      content: "Maya Chen joined the conversation",
    });
    await mock.reply({ author: "human", content: "Maya here, taking over." });
    const human = m.messages.locator(".msg").nth(2);
    await expect(human.locator(".author-name")).toHaveText("Maya Chen");
    await expect(human.locator(".tag")).toHaveCount(0);
    await expect(m.messages.locator(".system")).toHaveText(
      "Maya Chen joined the conversation",
    );
    await expect(m.live).toHaveText("Maya Chen: Maya here, taking over.");

    // Seen is posted after agent/human replies render.
    await waitForRequest(
      mock,
      (r) => r.method === "POST" && r.path.endsWith("/seen"),
    );
    await expect
      .poll(async () => (await mock.state()).conversations[0]!.unreadForContact)
      .toBe(0);

    // Shift+Enter inserts a newline; Enter sends.
    await m.textarea.press("a");
    await m.textarea.press("Shift+Enter");
    await m.textarea.press("b");
    await expect(m.textarea).toHaveValue("a\nb");
    await m.textarea.press("Enter");
    await expect(
      m.messages.locator(".msg.me").last().locator(".bubble"),
    ).toHaveText("a\nb");

    // Back to home lists the conversation.
    await m.back.click();
    await expect(m.host.locator(".row")).toHaveCount(1);
    await expect(m.host.locator(".row-preview")).toHaveText("a\nb");
  });

  test("polls only for new messages after the last id", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await m.textarea.fill("hello");
    await m.textarea.press("Enter");
    await expect(m.messages.locator(".msg")).toHaveCount(1);
    // A new thread has no active server conversation until this send creates
    // it, so this first list call establishes the fetched cursor.
    const initialRead = await waitForRequest(
      mock,
      (r) =>
        r.method === "GET" &&
        /\/messages(?:\?|$)/.test(r.path) &&
        new URLSearchParams(r.path.split("?")[1] ?? "").get("pagination") ===
          "cursor" &&
        !/[?&](?:after|before)=\d+/.test(r.path),
    );
    expect(initialRead.length).toBeGreaterThan(0);
    const nextPoll = waitForRequest(
      mock,
      (r) => {
        const query = new URLSearchParams(r.path.split("?")[1] ?? "");
        return (
          r.method === "GET" &&
          /\/messages\?/.test(r.path) &&
          query.get("pagination") === "cursor" &&
          query.has("after")
        );
      },
      15_000,
    );
    const polls = await nextPoll;
    expect(new URLSearchParams(polls[0]!.path.split("?")[1]).get("after")).toBe(
      "5001",
    );
    expect(
      new URLSearchParams(polls[0]!.path.split("?")[1]).get("pagination"),
    ).toBe("cursor");
    const requests = (await mock.state()).requests;
    const initialIndex = requests.findIndex(
      (r) =>
        r.method === "GET" &&
        /\/messages(?:\?|$)/.test(r.path) &&
        new URLSearchParams(r.path.split("?")[1] ?? "").get("pagination") ===
          "cursor" &&
        !/[?&](?:after|before)=\d+/.test(r.path),
    );
    const afterIndex = requests.findIndex((r) => {
      const query = new URLSearchParams(r.path.split("?")[1] ?? "");
      return /\/messages\?/.test(r.path) && query.has("after");
    });
    expect(initialIndex).toBeGreaterThanOrEqual(0);
    expect(afterIndex).toBeGreaterThan(initialIndex);
  });

  test("showNewMessage opens a prefilled composer without sending", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await page.getByRole("button", { name: "Ask a question" }).click();
    await expect(m.panel).toBeVisible();
    await expect(m.textarea).toHaveValue(
      "Hi! I have a question about my order.",
    );
    expect((await mock.state()).conversations).toHaveLength(0);
  });

  test("messages longer than 4,000 characters are blocked in the composer", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await m.textarea.fill("x".repeat(3_700));
    await expect(m.host.locator(".composer-note")).toHaveText(
      "300 characters left",
    );
    await m.textarea.fill("x".repeat(4_001));
    await expect(m.host.locator(".composer-note")).toHaveText(
      "Messages can be up to 4,000 characters.",
    );
    await expect(m.textarea).toHaveAttribute("aria-invalid", "true");
    await expect(m.host.locator(".send")).toBeDisabled();
  });

  test("usage limits keep the message and explain why", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await mock.fail({
      route: "send",
      status: 429,
      code: "daykeeper_usage_limit_exceeded",
    });
    await m.textarea.fill("will this send?");
    await m.textarea.press("Enter");
    const failed = m.messages.locator(".msg.failed");
    await expect(failed.locator(".bubble")).toHaveText("will this send?");
    await expect(failed.locator(".meta")).toContainText(
      "Messages can't be sent right now",
    );
  });

  test("a failed send offers a manual retry", async ({ page, mock }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await mock.fail({
      route: "send",
      status: 422,
      code: "support_upstream_rejected",
    });
    await m.textarea.fill("second try");
    await m.textarea.press("Enter");
    await m.messages.getByRole("button", { name: "Retry" }).click();
    await expect(m.messages.locator(".msg.failed")).toHaveCount(0);
    await expect(m.messages.locator(".msg .meta")).toContainText("You");
    expect((await mock.state()).conversations[0]!.messages).toHaveLength(1);
  });

  test("an uncertain create asks before sending into a newly appeared conversation", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await page.route(`${mock.gatewayUrl}/v1/conversations`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // Let the gateway create the conversation but drop the browser response,
      // reproducing the ambiguous outcome that must not be silently adopted.
      await route.fetch();
      await route.abort("failed");
    });
    await m.textarea.fill("keep this draft safe");
    await m.textarea.press("Enter");
    const pending = m.messages.locator(".msg.pending");
    await expect(pending).toContainText("couldn't confirm this was sent");
    const choose = m.messages.getByRole("button", {
      name: "Continue in conversation 1",
    });
    await expect(choose).toBeVisible();
    expect((await mock.state()).conversations[0]!.messages).toHaveLength(0);
    await choose.click();
    await expect(m.messages.locator(".msg.pending")).toHaveCount(0);
    expect(
      (await mock.state()).conversations[0]!.messages.map(
        (entry) => entry.content,
      ),
    ).toEqual(["keep this draft safe"]);
  });
});

test.describe("unread, storage, session", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(openShadowRoots);
  });

  test("a returning visitor sees an unread badge that clears when read", async ({
    page,
    mock,
  }) => {
    const seeded = await mock.seed({
      conversations: [
        {
          messages: [
            { author: "customer", content: "Where is my order?" },
            { author: "agent", content: "It left the warehouse this morning." },
          ],
        },
      ],
    });
    await storeVisitor(page, mock.publishableKey, seeded);
    await page.addInitScript(() => {
      (window as unknown as { __unread: unknown[] }).__unread = [];
      const install = () => {
        const dk = (
          window as unknown as { Daykeeper?: (...a: unknown[]) => void }
        ).Daykeeper;
        if (!dk) return setTimeout(install, 5);
        dk("on", "unreadCountChange", (n: unknown) =>
          (window as unknown as { __unread: unknown[] }).__unread.push(n),
        );
      };
      install();
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await expect(m.badge).toBeVisible();
    await expect(m.badge).toHaveText("1");
    await expect(m.launcher).toHaveAttribute(
      "aria-label",
      "Open support chat, 1 unread message",
    );
    // Resumed, not re-minted.
    const sessions = (await mock.state()).requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/visitor-sessions",
    );
    expect(sessions).toHaveLength(1);
    expect((await mock.state()).visitors).toEqual([seeded.visitorId]);

    await m.launcher.click();
    await expect(m.host.locator(".row.unread")).toHaveCount(1);
    await m.host.locator(".row").click();
    await expect(m.messages.locator(".msg")).toHaveCount(2);
    await waitForRequest(
      mock,
      (r) => r.method === "POST" && r.path.endsWith("/seen"),
    );
    await m.close.click();
    await expect(m.badge).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __unread: unknown[] }).__unread,
        ),
      )
      .toEqual([1, 0]);
  });

  test("closed panel badges a reply that arrives later", async ({
    page,
    mock,
  }) => {
    const seeded = await mock.seed({
      conversations: [
        { seen: true, messages: [{ author: "customer", content: "Hello?" }] },
      ],
    });
    await storeVisitor(page, mock.publishableKey, seeded);
    await page.clock.install();
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await waitForRequest(mock, (r) => r.path === "/v1/unread");
    await expect(m.badge).toBeHidden();
    await mock.reply({ author: "human", content: "Hi! Sorry for the wait." });
    await page.clock.runFor(30_500);
    await expect(m.badge).toHaveText("1");
    const unreadPolls = (await mock.state()).requests.filter(
      (r) => r.method === "GET" && r.path === "/v1/unread",
    );
    expect(unreadPolls).toHaveLength(2);
  });

  test("visitor_proof_invalid drops the stored visitor and mints a new one", async ({
    page,
    mock,
  }) => {
    const seeded = await mock.seed({
      conversations: [
        { messages: [{ author: "customer", content: "old thread" }] },
      ],
    });
    await mock.revoke();
    await storeVisitor(page, mock.publishableKey, seeded);
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await expect(m.host.locator(".hero-title")).toBeVisible();
    const state = await mock.state();
    expect(state.visitors).toHaveLength(2);
    const stored = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(`dk:messenger:${key}`)!),
      mock.publishableKey,
    );
    expect(stored.visitorId).not.toBe(seeded.visitorId);
    expect(stored.hasConversation).toBe(false);
  });

  test("a rejected token is refreshed and the thread keeps working", async ({
    page,
    mock,
  }) => {
    // The gateway reflects CORS only after verifying a token, so a rejected
    // token is an opaque network failure to the page (the mock does the same).
    test.setTimeout(90_000);
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await m.textarea.fill("first");
    await m.textarea.press("Enter");
    await expect(m.messages.locator(".msg .meta")).toContainText("You");
    await mock.rotateSigningKey();
    await mock.reply({ author: "agent", content: "after rotation" });
    await expect(
      m.messages.locator(".msg").nth(1).locator(".bubble"),
    ).toHaveText("after rotation", { timeout: 20_000 });
    const sessions = (await mock.state()).requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/visitor-sessions",
    );
    expect(sessions).toHaveLength(2);

    // A write whose token is rejected is never replayed automatically: it is
    // reconciled against the thread, then offered as a manual retry.
    await mock.rotateSigningKey();
    await m.textarea.fill("second");
    await m.textarea.press("Enter");
    const retry = m.messages.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible({ timeout: 45_000 });
    await expect(m.messages.locator(".msg.failed .meta")).toContainText(
      "We couldn't confirm this was sent.",
    );
    await retry.click();
    await expect(m.messages.locator(".msg.failed")).toHaveCount(0);
    const contents = (await mock.state()).conversations[0]!.messages.map(
      (x) => x.content,
    );
    expect(contents).toEqual(["first", "after rotation", "second"]);
  });

  test("works without localStorage (memory fallback)", async ({
    page,
    mock,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await m.textarea.fill("no storage here");
    await m.textarea.press("Enter");
    await expect(m.messages.locator(".msg.me .meta")).toContainText("You");
  });

  test("shutdown with forget removes the element and the stored visitor", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await expect(m.host.locator(".hero-title")).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { Daykeeper: (...a: unknown[]) => void }).Daykeeper(
        "shutdown",
        {
          forget: true,
        },
      ),
    );
    await expect(m.host).toHaveCount(0);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(`dk:messenger:${key}`),
        mock.publishableKey,
      ),
    ).toBeNull();
  });

  test("shutdown with forget fences a late visitor-session response", async ({
    page,
    mock,
  }) => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    await page.route("**/v1/visitor-sessions", async (route) => {
      const response = await route.fetch();
      markStarted();
      await gate;
      await route.fulfill({ response });
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await started;
    await page.evaluate(() =>
      (window as unknown as { Daykeeper: (...a: unknown[]) => void }).Daykeeper(
        "shutdown",
        { forget: true },
      ),
    );
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(`dk:messenger:${key}`),
        mock.publishableKey,
      ),
    ).toBeNull();
    release();
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(`dk:messenger:${key}`),
        mock.publishableKey,
      ),
    ).toBeNull();
  });
});

test.describe("message history", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(openShadowRoots);
  });

  test("loads older pages and displays attachment-only replies safely", async ({
    page,
    mock,
  }) => {
    const seeded = await mock.seed({
      conversations: [
        {
          messages: [
            ...Array.from({ length: 24 }, (_, index) => ({
              author: "agent" as const,
              content: `History ${index + 1}`,
            })),
            {
              author: "customer" as const,
              content: "",
              attachments: [
                {
                  id: 991,
                  fileType: "image/png",
                  dataUrl: "https://files.example.test/private.png",
                  thumbUrl: "https://files.example.test/private-thumb.png",
                },
              ],
            },
          ],
        },
      ],
    });
    await storeVisitor(page, mock.publishableKey, seeded);
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.host.locator(".row").first().click();
    await expect(m.messages.locator(".msg")).toHaveCount(20);
    await expect(m.messages.locator(".msg .bubble").last()).toHaveText(
      "Attachment",
    );
    await expect(m.messages.locator("img, a")).toHaveCount(0);
    await m.host.getByRole("button", { name: "Load older messages" }).click();
    await expect(m.messages.locator(".msg")).toHaveCount(25);
    await expect(m.messages.locator(".msg .bubble").first()).toHaveText(
      "History 1",
    );
    await m.host.getByRole("button", { name: "Load older messages" }).click();
    await expect(
      m.host.getByRole("button", { name: "Load older messages" }),
    ).toBeHidden();
  });
});

test.describe("error states", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(openShadowRoots);
  });

  test("unknown key is opaque to the page: connection state plus a console hint", async ({
    page,
    mock,
  }) => {
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/?key=unknown`);
    await m.launcher.click();
    await expect(m.host.locator(".state-title")).toHaveText("We can't connect");
    expect(warnings.join("\n")).toContain(
      "allowed website for this publishable key",
    );
  });

  test("readable web_client_unavailable: unavailable, no retries", async ({
    page,
    mock,
  }) => {
    await mock.configure({ exposeSessionErrors: true });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/?key=unknown`);
    await m.launcher.click();
    await expect(m.host.locator(".state-title")).toHaveText(
      "Chat is unavailable",
    );
    await expect(m.host.locator(".state button")).toHaveCount(0);
    await page.waitForTimeout(5_000);
    expect(
      (await mock.state()).requests.filter((r) => r.method === "POST"),
    ).toHaveLength(1);
  });

  test("web_client_disabled from the gateway ends the session", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await expect(m.host.locator(".hero-title")).toBeVisible();
    await m.newConversation.click();
    await mock.configure({ state: "disabled" });
    await m.textarea.fill("anyone there?");
    await m.textarea.press("Enter");
    await expect(m.host.locator(".state-title")).toHaveText(
      "Chat is unavailable",
    );
  });

  test("temporarily_unavailable: connection state with a working Try again", async ({
    page,
    mock,
  }) => {
    await mock.fail({
      route: "sessions",
      status: 503,
      code: "temporarily_unavailable",
      times: 1,
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await expect(m.host.locator(".state-title")).toHaveText("We can't connect");
    const retry = m.host.getByRole("button", { name: "Try again" });
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(m.host.locator(".hero-title")).toBeVisible();
  });

  test("origin not allowed looks like a network failure and hints in the console", async ({
    page,
    mock,
  }) => {
    await mock.configure({ allowedOrigins: ["https://elsewhere.example"] });
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await expect(m.host.locator(".state-title")).toHaveText("We can't connect");
    expect(warnings.join("\n")).toContain(
      "is an allowed website for this publishable key",
    );
  });

  test("a failing poll shows a reconnecting banner, then recovers", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await m.newConversation.click();
    await m.textarea.fill("hello");
    await m.textarea.press("Enter");
    await expect(m.messages.locator(".msg .meta")).toContainText("You");
    await mock.fail({
      route: "messages",
      status: 502,
      code: "support_upstream_unavailable",
      times: 1,
    });
    await expect(m.host.locator(".banner")).toHaveText(
      "Connection lost. Reconnecting…",
    );
    await mock.reply({ author: "agent", content: "back online" });
    await expect(m.host.locator(".banner")).toBeHidden({ timeout: 15_000 });
    await expect(
      m.messages.locator(".msg").nth(1).locator(".bubble"),
    ).toHaveText("back online");
  });
});

test.describe("keyboard, focus, mobile, a11y", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(openShadowRoots);
  });

  test("keyboard: open, move focus in, Esc closes and returns focus", async ({
    page,
    mock,
  }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.focus();
    await page.keyboard.press("Enter");
    await expect(m.newConversation).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(m.textarea).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(m.panel).toBeHidden();
    await expect(m.launcher).toBeFocused();
    await expect(m.launcher).toHaveAttribute("aria-expanded", "false");
    // Reopening returns to the same view.
    await page.keyboard.press("Space");
    await expect(m.textarea).toBeFocused();
  });

  test("touch targets are at least 44 px", async ({ page, mock }) => {
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/`);
    await m.launcher.click();
    await expect(m.newConversation).toBeVisible();
    await page.waitForTimeout(400); // let the open transition settle
    for (const target of [m.launcher, m.close, m.newConversation]) {
      const box = (await target.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test.describe("mobile", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });

    test("full-screen modal sheet with focus trap and scroll lock", async ({
      page,
      mock,
    }) => {
      const m = messenger(page);
      await page.goto(`${mock.siteUrl}/`);
      await m.launcher.click();
      await expect(m.panel).toBeVisible();
      await expect(m.panel).toHaveAttribute("aria-modal", "true");
      await page.waitForTimeout(400); // let the open transition settle
      const box = (await m.panel.boundingBox())!;
      expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
      await expect(m.launcher).toBeHidden();
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).overflow,
        ),
      ).toBe("hidden");
      // Tab cycles inside the sheet.
      await expect(m.close).toBeFocused();
      const seen = new Set<string>();
      for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press("Tab");
        const inside = await m.panel.evaluate((panel) => {
          const root = panel.getRootNode() as ShadowRoot;
          return panel.contains(root.activeElement);
        });
        expect(inside).toBe(true);
        seen.add(
          await page.evaluate(() => document.activeElement?.tagName ?? ""),
        );
      }
      expect([...seen]).toEqual(["DAYKEEPER-MESSENGER"]);
      await m.close.click();
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).overflow,
        ),
      ).toBe("visible");
    });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds no WCAG A/AA violations (${scheme})`, async ({
      page,
      mock,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seeded = await mock.seed({
        conversations: [
          {
            messages: [
              { author: "customer", content: "Hello" },
              {
                author: "agent",
                content: "Hi! How can I help? See https://example.com.",
              },
              {
                author: "system",
                content: "Maya Chen joined the conversation",
              },
              { author: "human", content: "Maya here." },
            ],
          },
        ],
      });
      await storeVisitor(page, mock.publishableKey, seeded);
      const m = messenger(page);
      await page.goto(`${mock.siteUrl}/`);
      await expect(m.badge).toBeVisible();
      await page.evaluate(AXE);
      const run = () =>
        page.evaluate(async () => {
          const axe = (window as unknown as { axe: any }).axe;
          const result = await axe.run(
            { include: [["daykeeper-messenger"]] },
            {
              runOnly: {
                type: "tag",
                values: [
                  "wcag2a",
                  "wcag2aa",
                  "wcag21a",
                  "wcag21aa",
                  "wcag22aa",
                ],
              },
            },
          );
          return result.violations.map(
            (v: { id: string; nodes: { target: unknown }[] }) =>
              `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`,
          );
        });
      expect(await run()).toEqual([]);
      await m.launcher.click();
      await expect(m.host.locator(".row")).toHaveCount(1);
      await page.waitForTimeout(300);
      expect(await run()).toEqual([]);
      await m.host.locator(".row").click();
      await expect(m.messages.locator(".msg")).toHaveCount(3);
      await page.waitForTimeout(300);
      expect(await run()).toEqual([]);
    });
  }
});

test.describe("isolation", () => {
  // No openShadowRoots here: the real closed shadow root, hostile page CSS,
  // strict CSP with Trusted Types. Driven by coordinates and keyboard only.
  test("hostile CSS and strict CSP cannot break or reach the messenger", async ({
    page,
    mock,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[]; __keys: string[] };
      w.__csp = [];
      w.__keys = Object.keys(window);
      document.addEventListener("securitypolicyviolation", (event) =>
        w.__csp.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`${mock.siteUrl}/hostile`);
    await page.waitForFunction(
      () => !!document.querySelector("daykeeper-messenger"),
    );

    const host = await page.evaluate(() => {
      const el = document.querySelector("daykeeper-messenger") as HTMLElement;
      const style = getComputedStyle(el);
      return {
        shadowRoot: el.shadowRoot === null ? "closed" : "open",
        position: style.position,
        display: style.display,
        opacity: style.opacity,
        transform: style.transform,
        zIndex: style.zIndex,
        hit: document.elementFromPoint(1280 - 50, 860 - 50)?.tagName,
      };
    });
    expect(host).toEqual({
      shadowRoot: "closed",
      position: "fixed",
      display: "block",
      opacity: "1",
      transform: "none",
      zIndex: "2147483000",
      hit: "DAYKEEPER-MESSENGER",
    });

    // The launcher's pixels match the same launcher on an ordinary page.
    const centre = {
      x: 1280 - 20 - 30 - 15,
      y: 860 - 20 - 30 - 15,
      width: 30,
      height: 30,
    };
    const hostilePixels = await page.screenshot({ clip: centre });
    const plain = await page.context().newPage();
    await plain.setViewportSize({ width: 1280, height: 860 });
    await plain.goto(`${mock.siteUrl}/`);
    await plain.waitForFunction(
      () => !!document.querySelector("daykeeper-messenger"),
    );
    await plain.waitForTimeout(300);
    expect(hostilePixels.equals(await plain.screenshot({ clip: centre }))).toBe(
      true,
    );
    await plain.close();

    await page.mouse.click(1280 - 50, 860 - 50);
    // The panel occupies the area above the launcher.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.elementFromPoint(1280 - 220, 400)?.tagName,
        ),
      )
      .toBe("DAYKEEPER-MESSENGER");
    await page.waitForTimeout(500);
    // Keyboard only: focus is on "New conversation"; open it and send.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.keyboard.type("typed under hostile CSS");
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () => (await mock.state()).conversations[0]?.messages[0]?.content,
      )
      .toBe("typed under hostile CSS");
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.elementFromPoint(1280 - 220, 400)?.tagName,
        ),
      )
      .not.toBe("DAYKEEPER-MESSENGER");

    const leaks = await page.evaluate(() => {
      const w = window as unknown as { __csp: string[]; __keys: string[] };
      const added = Object.keys(window).filter(
        (key) => !w.__keys.includes(key) && !key.startsWith("__"),
      );
      return { csp: w.__csp, added };
    });
    expect(leaks).toEqual({ csp: [], added: ["Daykeeper"] });
    expect(errors).toEqual([]);
  });

  test("hideLauncher leaves opening to the page", async ({ page, mock }) => {
    await page.addInitScript(openShadowRoots);
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/?hideLauncher=1`);
    await page.waitForFunction(
      () => !!document.querySelector("daykeeper-messenger"),
    );
    await expect(m.launcher).toBeHidden();
    await page.getByRole("button", { name: "Ask a question" }).focus();
    await page.evaluate(() => {
      (window as unknown as { Daykeeper: (c: string) => void }).Daykeeper(
        "show",
      );
      // Escape in the same task targets the page control before the widget's
      // scheduled focus transfer; the open panel must still be dismissible.
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    });
    await expect(m.panel).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Ask a question" }),
    ).toBeFocused();
  });

  test("the snippet queue works when commands run before the script loads", async ({
    page,
    mock,
  }) => {
    await page.addInitScript(openShadowRoots);
    await page.route("**/messenger.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.addInitScript(() => {
      const w = window as unknown as {
        Daykeeper: ((...a: unknown[]) => void) & { q?: unknown[] };
        __events: string[];
      };
      w.__events = [];
      w.Daykeeper =
        w.Daykeeper ||
        function (...args: unknown[]) {
          (w.Daykeeper.q = w.Daykeeper.q || []).push(args);
        };
      w.Daykeeper("on", "ready", () => w.__events.push("ready"));
      w.Daykeeper("on", "open", () => w.__events.push("open"));
      w.Daykeeper("on", "close", () => w.__events.push("close"));
    });
    const m = messenger(page);
    await page.goto(`${mock.siteUrl}/?theme=dark&position=left`);
    await expect(m.launcher).toBeVisible();
    const box = (await m.launcher.boundingBox())!;
    expect(box.x).toBeLessThan(100);
    await expect(m.host.locator(".dk")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() =>
      (window as unknown as { Daykeeper: (c: string) => void }).Daykeeper(
        "toggle",
      ),
    );
    await expect(m.panel).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { Daykeeper: (c: string) => void }).Daykeeper(
        "hide",
      ),
    );
    await expect(m.panel).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as unknown as { __events: string[] }).__events,
      ),
    ).toEqual(["ready", "open", "close"]);
  });
});
