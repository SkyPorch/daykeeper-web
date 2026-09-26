import { defineConfig } from "@playwright/test";

// Chromium only; the browser build comes from the local Playwright cache
// (`pnpm exec playwright install chromium` once per machine/CI runner).
export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "retain-on-failure" },
  projects: [
    { name: "e2e", testIgnore: /screenshots\.spec\.ts/ },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/ },
  ],
});
