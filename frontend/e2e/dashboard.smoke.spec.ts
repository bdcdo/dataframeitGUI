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

    try {
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: "Meus Projetos" }),
      ).toBeVisible();
    } finally {
      // Garante que a sessão é encerrada mesmo se a asserção falhar.
      await clerk.signOut({ page });
    }
  });
}
