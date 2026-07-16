import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { assertRequiredPrePushEnv } from "./playwright-pre-push-env";

// E2E lê as mesmas credenciais Clerk/Supabase de .env.local; .env.e2e (não
// versionado) sobrescreve com as credenciais dos usuários de teste. Ver
// .env.e2e.example e issue #107.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.e2e", override: true });

// Setado só pelo hook e2e-smoke do pre-push (nao pelo `npm run test:e2e`
// manual): forca servidor novo, porta dedicada e execucao serial, porque o
// modo "dev" abaixo (paralelo + reaproveita servidor na porta padrao) e
// otimizado para iteracao local, nao para um gate deterministico que roda a
// cada `git push` em worktrees paralelas.
const isPrePush = !!process.env.PLAYWRIGHT_PRE_PUSH;

if (isPrePush) assertRequiredPrePushEnv(process.env);

// CI e pre-push sao os dois contextos "gated" (execucao deterministica, sem
// paralelismo nem reaproveitamento de servidor) — usar um unico booleano nos
// dois lugares abaixo evita que `workers` e `reuseExistingServer` divirjam
// se um dos dois for atualizado sem o outro no futuro.
const isGatedRun = !!process.env.CI || isPrePush;

// Porta dedicada (3100) é o default do pre-push quando E2E_BASE_URL não foi
// definido. E2E_BASE_URL explícito continua tendo prioridade e a porta
// repassada ao `next dev` acompanha a URL escolhida.
const baseURL =
  process.env.E2E_BASE_URL ??
  (isPrePush ? "http://localhost:3100" : "http://localhost:3000");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serial no pre-push: specs em arquivos diferentes autenticando em paralelo
  // reintroduziriam o burst de clerk.signIn() contra o tenant dev que a #198/
  // PR #294 ja corrigiu (aquele fix so serializa dentro de um arquivo).
  workers: isGatedRun ? 1 : undefined,
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
    // Repassa ao `next dev` a porta escolhida em baseURL; no pre-push, o
    // default é 3100, mas E2E_BASE_URL explícito pode escolher outra porta.
    env: isPrePush ? { PORT: new URL(baseURL).port } : undefined,
    // No pre-push, nunca reaproveitar: o default 3100 evita colidir com o dev
    // server interativo em 3000; com E2E_BASE_URL explícito, o caller assume a
    // porta escolhida para este gate.
    reuseExistingServer: !isGatedRun,
    timeout: 120_000,
  },
});
