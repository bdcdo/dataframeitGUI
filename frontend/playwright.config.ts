import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// E2E lê as mesmas credenciais Clerk/Supabase de .env.local; .env.e2e (não
// versionado) sobrescreve com as credenciais dos usuários de teste. Ver
// .env.e2e.example e issue #107.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.e2e", override: true });

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
