import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Cada papel mapeia para um usuário Clerk de teste real (no tenant de dev).
// As credenciais ficam em .env.e2e (não versionado) — ver .env.e2e.example.
// Sem as credenciais o teste é pulado em vez de falhar, para não quebrar CI
// em forks/ambientes que não têm o tenant de teste configurado.
const roles = [
  {
    role: "coordenador",
    emailEnv: "E2E_COORDINATOR_EMAIL",
    passwordEnv: "E2E_COORDINATOR_PASSWORD",
  },
  {
    role: "membro",
    emailEnv: "E2E_MEMBER_EMAIL",
    passwordEnv: "E2E_MEMBER_PASSWORD",
  },
  {
    role: "master",
    emailEnv: "E2E_MASTER_EMAIL",
    passwordEnv: "E2E_MASTER_PASSWORD",
  },
] as const;

for (const { role, emailEnv, passwordEnv } of roles) {
  test(`dashboard carrega autenticado como ${role}`, async ({ page }) => {
    const identifier = process.env[emailEnv];
    const password = process.env[passwordEnv];
    test.skip(
      !identifier || !password,
      `defina ${emailEnv} e ${passwordEnv} em .env.e2e`,
    );

    // Injeta o Testing Token nas requisições da página, dispensando o
    // challenge anti-bot do Clerk.
    await setupClerkTestingToken({ page });

    await page.goto("/auth/login");
    await clerk.signIn({
      page,
      signInParams: {
        strategy: "password",
        identifier: identifier!,
        password: password!,
      },
    });

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
