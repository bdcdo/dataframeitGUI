import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { assertRequiredPrePushEnv } from "./playwright-pre-push-env";
import {
  applyEnvironment,
  readOptionalEnvironmentFile,
  readEnvironmentFile,
} from "./scripts/worktree-env/env-contract.mjs";

// E2E lê as mesmas credenciais Clerk/Supabase de .env.local; .env.e2e (não
// versionado) sobrescreve com as credenciais dos usuários de teste. Ver
// .env.e2e.example e issue #107.
//
// Ancorar em __dirname, e não no cwd: o contrato (playwright-pre-push-env) já
// resolve os .example por __dirname, então ler os valores por cwd faria um
// `playwright test -c frontend/playwright.config.ts` rodado da raiz do repo
// achar o contrato mas nenhum valor — e o erro resultante acusaria credencial
// ausente em vez do diretório errado.
applyEnvironment(
  process.env,
  readOptionalEnvironmentFile(join(__dirname, ".env.local")),
);
applyEnvironment(
  process.env,
  process.env.E2E_ENV_PATH
    ? readEnvironmentFile(process.env.E2E_ENV_PATH)
    : readOptionalEnvironmentFile(join(__dirname, ".env.e2e")),
  { override: true },
);

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
    // Execução gated roda contra o build de produção, não contra o `next dev`.
    // O `next dev` só conhece uma rota depois que a varredura do app dir (o
    // Watchpack de setup-dev-bundler) a registra, mas já atende requests no
    // meio dela: o middleware responde `/` com 307, e é isso que o Playwright
    // aceita como "pronto". Com a máquina carregada a varredura leva segundos
    // (13 s medidos com load ~60), e cada evento dela reescreve a tabela de
    // rotas num handler assíncrono sem trava, que pode terminar fora de ordem.
    // Request que chega antes recebe o 404 embutido do Next, sem erro no log,
    // e o spec acusa o fixture. O `next start` lê as rotas do manifesto do
    // build e compila tudo antes, o que também tira dos testes a compilação
    // sob demanda que estourava o timeout de `page.goto` sob carga.
    //
    // O `next start` avisa que não é o comando de `output: standalone`; o
    // aviso trata do deploy (ver Dockerfile), e aqui ele serve o `.next` do
    // build normalmente, lendo `.env.local` como o `next dev`. O build roda em
    // `.next/` e o `next dev` interativo em `.next/dev/`, então os dois
    // convivem no mesmo checkout.
    command: isGatedRun ? "npm run build && npm run start" : "npm run dev",
    url: baseURL,
    // Repassa ao servidor a porta escolhida em baseURL; no pre-push, o
    // default é 3100, mas E2E_BASE_URL explícito pode escolher outra porta.
    env: isPrePush ? { PORT: new URL(baseURL).port } : undefined,
    // No pre-push, nunca reaproveitar: o default 3100 evita colidir com o dev
    // server interativo em 3000; com E2E_BASE_URL explícito, o caller assume a
    // porta escolhida para este gate.
    reuseExistingServer: !isGatedRun,
    // Prazo de subida do servidor, não de teste: no modo gated ele inclui o
    // `next build` inteiro (49 s com load ~60), trabalho que o `next dev`
    // fazia aos poucos dentro do timeout de cada teste.
    timeout: isGatedRun ? 600_000 : 120_000,
  },
});
