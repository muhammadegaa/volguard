import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3000";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL, channel: "chrome", ...devices["Desktop Chrome"] },
  webServer: { command: `npm run dev -- --port ${port}`, url: baseURL, reuseExistingServer: true },
});
