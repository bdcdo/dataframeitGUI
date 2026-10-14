import { test as base } from "@playwright/test";
import {
  acquireFixtureLock,
  defaultFixtureLockDir,
  type HeldFixtureLock,
} from "./fixture-lock";

// `test` dos specs que mutam um projeto fixture remoto. O fixture
// `holdFixtureLock` toma o lock do projeto (ver fixture-lock.ts) e o solta no
// teardown, que o Playwright roda mesmo quando o teste falha ou estoura o
// timeout. Chamar ANTES do primeiro reset: o lock existe para que o DELETE de
// uma execução não caia no meio do teste de outra.

// Teto da espera. Cobre um teste inteiro da outra execução (o maior timeout
// entre os specs que mutam fixture é 180s) com folga; passado isso, a falha
// nomeia o dono em vez de deixar uma asserção de banco acusar o produto.
const DEFAULT_WAIT_MS = 5 * 60_000;

function waitMsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.E2E_FIXTURE_LOCK_WAIT_MS;
  if (!raw) return DEFAULT_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`E2E_FIXTURE_LOCK_WAIT_MS inválido: "${raw}"`);
  }
  return parsed;
}

export const test = base.extend<{
  holdFixtureLock: (projectId: string) => Promise<void>;
}>({
  // O Playwright exige desestruturar as dependências do fixture, mesmo vazias.
  // O segundo argumento é o `use` da API de fixtures; outro nome evita que a
  // regra de hooks do React o confunda com `React.use`.
  holdFixtureLock: async ({}, provide, testInfo) => {
    const held: HeldFixtureLock[] = [];
    await provide(async (projectId) => {
      const lock = await acquireFixtureLock(projectId, {
        dir: defaultFixtureLockDir(),
        label: testInfo.titlePath.join(" › "),
        waitMs: waitMsFromEnv(process.env),
        onWait: (owner) => {
          console.log(
            `[fixture-lock] projeto ${projectId} ocupado por ` +
              (owner
                ? `"${owner.label}" (pid ${owner.pid}, ${owner.cwd})`
                : "dono ilegível") +
              "; aguardando.",
          );
        },
      });
      held.push(lock);
      // A espera não come o orçamento do teste: sem isto, esperar um teste de
      // 180s da outra execução estouraria o timeout deste antes de começar.
      // Timeout 0 é "sem limite" e fica como está.
      if (testInfo.timeout > 0) {
        testInfo.setTimeout(testInfo.timeout + lock.waitedMs);
      }
    });
    for (const lock of held.reverse()) lock.release();
  },
});
