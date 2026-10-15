import { test as base } from "./base-test";
import {
  createFixtureLockHolder,
  defaultFixtureLockDir,
  fixtureLockWaitMs,
} from "./fixture-lock";

// `test` dos specs que mutam um projeto fixture remoto. O fixture
// `holdFixtureLock` toma o lock do projeto (ver fixture-lock.ts) e o solta no
// teardown, que o Playwright roda mesmo quando o teste falha ou estoura o
// timeout. Chamar ANTES do primeiro reset: o lock existe para que o DELETE de
// uma execução não caia no meio do teste de outra. A política de espera e de
// timeout mora em `createFixtureLockHolder`, testável sem o runner. Estende o
// `test` de base-test.ts, então estes specs também ganham o diagnóstico de
// navegação.

export const test = base.extend<{
  holdFixtureLock: (projectId: string) => Promise<void>;
}>({
  // O Playwright exige desestruturar as dependências do fixture, mesmo vazias.
  // O segundo argumento é o `use` da API de fixtures; outro nome evita que a
  // regra de hooks do React o confunda com `React.use`.
  holdFixtureLock: async ({}, provide, testInfo) => {
    const holder = createFixtureLockHolder(testInfo, {
      dir: defaultFixtureLockDir(),
      waitMs: fixtureLockWaitMs(process.env),
      onWait: (projectId, owner) => {
        console.log(
          `[fixture-lock] projeto ${projectId} ocupado por ` +
            (owner
              ? `"${owner.label}" (pid ${owner.pid}, ${owner.cwd})`
              : "dono ilegível") +
            "; aguardando.",
        );
      },
    });
    try {
      await provide(holder.hold);
    } finally {
      holder.releaseAll();
    }
  },
});
