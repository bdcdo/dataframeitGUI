import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

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
// CI e pre-push sao os dois contextos "gated" (execucao deterministica, sem
// paralelismo nem reaproveitamento de servidor) — usar um unico booleano nos
// dois lugares abaixo evita que `workers` e `reuseExistingServer` divirjam
// se um dos dois for atualizado sem o outro no futuro.
const isGatedRun = !!process.env.CI || isPrePush;

// Porta dedicada (3100) no pre-push, distinta da porta padrao (3000) do
// `npm run dev` interativo: com reuseExistingServer:false, o Playwright nao
// distingue "servidor da worktree errada" de "servidor legitimo do proprio
// dev" — qualquer coisa ja escutando na porta faz o webServer abortar com
// erro em vez de isolar a run. Isolar por porta evita colidir com o
// `npm run dev` que o proprio desenvolvedor pode ja ter aberto na mesma
// branch que esta sendo empurrada (fluxo comum, ex.: `npm run scan` tambem
// assume um dev server já rodando). `E2E_BASE_URL` explicito continua
// tendo prioridade sobre esse default.
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
    // Repassa a porta dedicada acima para o `next dev` via PORT — sem isso
    // o servidor subiria sempre em 3000 e a porta dedicada em baseURL não
    // corresponderia a nada.
    env: isPrePush ? { PORT: new URL(baseURL).port } : undefined,
    // No pre-push, nunca reaproveitar: a porta dedicada acima ja evita
    // colidir com o dev server do proprio desenvolvedor; resta so o risco
    // residual (raro) de duas worktrees-irmas empurrando ao mesmo tempo e
    // disputando essa mesma porta dedicada.
    reuseExistingServer: !isGatedRun,
    timeout: 120_000,
  },
});
