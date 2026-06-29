import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Cada papel mapeia para um usuário Clerk de teste real (no tenant de dev).
// Os e-mails ficam em .env.e2e (não versionado) — ver .env.e2e.example.
// Sem eles o teste é pulado em vez de falhar, para não quebrar CI em
// forks/ambientes que não têm o tenant de teste configurado.
//
// Login por ticket (token de sign-in criado server-side com a
// CLERK_SECRET_KEY): dispensa senha e não esbarra na verificação de "novo
// dispositivo" da instância, que bloqueia a estratégia password em contexto
// headless — cada contexto Playwright é um dispositivo novo.

// Roda os papéis em SÉRIE (não em paralelo). Cada signIn/signOut/currentUser
// bate na instância de DEV do Clerk, que tem limites de uso estritos; rodar os
// papéis em paralelo gera um burst que dispara rate-limit / `fetch failed` no
// backend do Clerk e torna o smoke flaky (issue #198 — a falha não era
// credencial nem o sync Clerk↔Supabase, ambos íntegros). Em série o ritmo fica
// abaixo do limite.
test.describe.configure({ mode: "serial" });

const roles = [
  { role: "coordenador", emailEnv: "E2E_COORDINATOR_EMAIL" },
  { role: "membro", emailEnv: "E2E_MEMBER_EMAIL" },
  { role: "master", emailEnv: "E2E_MASTER_EMAIL" },
] as const;

for (const { role, emailEnv } of roles) {
  test(`dashboard carrega autenticado como ${role}`, async ({ page }) => {
    const identifier = process.env[emailEnv];
    test.skip(!identifier, `defina ${emailEnv} em .env.e2e`);

    // Injeta o Testing Token nas requisições da página, dispensando o
    // challenge anti-bot do Clerk.
    await setupClerkTestingToken({ page });

    await page.goto("/auth/login");
    await clerk.signIn({ page, emailAddress: identifier! });

    // Espera a sessão Clerk ficar ativa no cliente antes de navegar. O signIn
    // resolve quando a sessão existe client-side, mas o cookie de sessão pode
    // não ter propagado para a navegação server-side imediatamente seguinte —
    // aí `currentUser()` no guard de /dashboard não vê a sessão e manda de
    // volta ao login (a race do #198).
    await page.waitForFunction(
      () =>
        (window as unknown as { Clerk?: { session?: { status?: string } } })
          .Clerk?.session?.status === "active",
      { timeout: 15_000 },
    );

    try {
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: "Meus Projetos" }),
      ).toBeVisible();
    } finally {
      // Encerra a sessão mesmo se a asserção falhar. clerk.signOut faz
      // page.evaluate sobre window.Clerk e pode pendurar se a página não
      // estiver no estado esperado (ver nota em lottery.smoke.spec.ts); limita
      // a 5s para não estourar o timeout do teste e mascarar a causa real — o
      // contexto isolado do Playwright já descarta os cookies entre testes.
      await Promise.race([
        clerk.signOut({ page }).catch(() => {}),
        page.waitForTimeout(5_000),
      ]);
    }
  });
}
