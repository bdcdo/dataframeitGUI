import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { withClerkCleanup } from "./clerk-cleanup";

// Valida o guard server-side de #27: um usuário com role "pesquisador" que conheça
// a URL de uma rota `config/*` é redirecionado para `analyze/code`.
// Requer, além do e-mail do pesquisador, E2E_PROJECT_ID — um projeto
// onde esse usuário é pesquisador (NÃO coordenador). Pulado se faltar qualquer
// um, para não quebrar CI sem o tenant de teste configurado.
// Login por ticket — ver nota em dashboard.smoke.spec.ts.
test("pesquisador é redirecionado de config/* para analyze/code", async ({
  page,
}) => {
  const identifier = process.env.E2E_MEMBER_EMAIL;
  const projectId = process.env.E2E_PROJECT_ID;
  const hasClerkTestingEnv =
    !!process.env.CLERK_SECRET_KEY &&
    !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  test.skip(
    !hasClerkTestingEnv || !identifier || !projectId,
    "defina CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, E2E_MEMBER_EMAIL e E2E_PROJECT_ID",
  );

  await setupClerkTestingToken({ page });

  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: identifier! });

  await withClerkCleanup({
    page,
    context: "config-guard",
    run: async () => {
      await page.goto(`/projects/${projectId}/config/schema`);
      await expect(page).toHaveURL(
        new RegExp(`/projects/${projectId}/analyze/code`),
      );
    },
  });
});
