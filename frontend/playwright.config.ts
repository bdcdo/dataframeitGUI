import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// E2E lê as mesmas credenciais Clerk/Supabase de .env.local; .env.e2e (não
// versionado) sobrescreve com as credenciais dos usuários de teste. Ver
// .env.e2e.example e issue #107.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.e2e", override: true });

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// Setado só pelo hook e2e-smoke do pre-push (nao pelo `npm run test:e2e`
// manual): forca servidor novo e execucao serial, porque o modo "dev" abaixo
// (paralelo + reaproveita servidor) e otimizado para iteracao local, nao para
// um gate deterministico que roda a cada `git push` em worktrees paralelas.
const isPrePush = !!process.env.PLAYWRIGHT_PRE_PUSH;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serial no pre-push: specs em arquivos diferentes autenticando em paralelo
  // reintroduziriam o burst de clerk.signIn() contra o tenant dev que a #198/
  // PR #294 ja corrigiu (aquele fix so serializa dentro de um arquivo).
  workers: process.env.CI || isPrePush ? 1 : undefined,
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
    // No pre-push, nunca reaproveitar: com worktrees paralelas e comum ja
    // haver um `npm run dev` de OUTRA branch escutando em localhost:3000, e
    // reusa-lo validaria o codigo errado.
    reuseExistingServer: !process.env.CI && !isPrePush,
    timeout: 120_000,
  },
});
