import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  messenger,
  openShadowRoots,
  storeVisitor,
  test,
} from "./fixtures.ts";

// Review screenshots: desktop + 390 px mobile, light + dark, for the closed
// launcher with an unread badge, home, a thread with AI-agent and human
// replies, and an error state. SCREENSHOT_DIR overrides the output folder.
const OUT =
  process.env.SCREENSHOT_DIR ??
  join(process.cwd(), "test-results", "screenshots");
mkdirSync(OUT, { recursive: true });

const sizes = {
  desktop: { width: 1280, height: 860 },
  mobile: { width: 390, height: 844 },
} as const;

for (const [device, viewport] of Object.entries(sizes)) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${device} ${scheme}`, () => {
      test.use({
        viewport,
        colorScheme: scheme,
        deviceScaleFactor: 2,
        isMobile: device === "mobile",
        hasTouch: device === "mobile",
      });

      test("closed, home, thread", async ({ page, mock }) => {
        await page.addInitScript(openShadowRoots);
        const seeded = await mock.seed({
          conversations: [
            {
              ageSeconds: 3 * 86_400,
              seen: true,
              messages: [
                {
                  author: "customer",
                  content: "Can I change the delivery address on my order?",
                  ageSeconds: 3 * 86_400,
                },
                {
                  author: "agent",
                  content: "Done! Your order will now ship to the new address.",
                  ageSeconds: 3 * 86_400 - 60,
                },
              ],
            },
            {
              ageSeconds: 600,
              messages: [
                {
                  author: "customer",
                  content:
                    "Hi! Do you ship to Canada? I'm looking at the oat duvet cover.",
                  ageSeconds: 540,
                },
                {
                  author: "agent",
                  content:
                    "Yes, we ship to Canada! Orders over **$150** ship free, and delivery takes 5 to 8 business days. Rates are at https://example.com/shipping.",
                  ageSeconds: 520,
                },
                {
                  author: "customer",
                  content: "Great. Could it arrive before the 12th?",
                  ageSeconds: 300,
                },
                {
                  author: "agent",
                  content:
                    "Let me bring in someone from our team who can check the warehouse schedule for you.",
                  ageSeconds: 290,
                },
                {
                  author: "system",
                  content: "Maya Chen joined the conversation",
                  ageSeconds: 200,
                },
                {
                  author: "human",
                  senderName: "Maya Chen",
                  content:
                    "Hi, Maya here. I've flagged your order for priority packing, so it should arrive by the 10th.",
                  ageSeconds: 120,
                },
              ],
            },
          ],
        });
        await storeVisitor(page, mock.publishableKey, seeded);
        const m = messenger(page);
        await page.goto(`${mock.siteUrl}/`);
        await expect(m.badge).toHaveText("3");
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: join(OUT, `${device}-${scheme}-1-closed-badge.png`),
        });

        await m.launcher.click();
        await expect(m.host.locator(".row")).toHaveCount(2);
        await page.waitForTimeout(400);
        await page.screenshot({
          path: join(OUT, `${device}-${scheme}-2-home.png`),
        });

        await m.host.locator(".row").first().click();
        await expect(m.host.locator(".msg")).toHaveCount(5);
        await page.waitForTimeout(500);
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: join(OUT, `${device}-${scheme}-3-thread.png`),
        });

        await m.textarea.fill("Perfect, thank you both!");
        await page.screenshot({
          path: join(OUT, `${device}-${scheme}-4-composing.png`),
        });
      });

      test("error state", async ({ page, mock }) => {
        await page.addInitScript(openShadowRoots);
        await mock.fail({
          route: "sessions",
          status: 503,
          code: "temporarily_unavailable",
          times: 99,
        });
        const m = messenger(page);
        await page.goto(`${mock.siteUrl}/`);
        await m.launcher.click();
        await expect(m.host.locator(".state")).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({
          path: join(OUT, `${device}-${scheme}-5-error.png`),
        });
      });
    });
  }
}
