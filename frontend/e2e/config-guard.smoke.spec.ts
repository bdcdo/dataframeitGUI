import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Valida o guard server-side de #27: um pesquisador (role "membro") que conheça
// a URL de uma rota `config/*` é redirecionado para `my-progress`.
// Requer, além das credenciais do usuário membro, E2E_PROJECT_ID — um projeto
// onde esse usuário é pesquisador (NÃO coordenador). Pulado se faltar qualquer
// um, para não quebrar CI sem o tenant de teste configurado.
test("pesquisador é redirecionado de config/* para my-progress", async ({
  page,
}) => {
  const identifier = process.env.E2E_MEMBER_EMAIL;
  const password = process.env.E2E_MEMBER_PASSWORD;
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(
    !identifier || !password || !projectId,
    "defina E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD e E2E_PROJECT_ID em .env.e2e",
  );

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
    await page.goto(`/projects/${projectId}/config/schema`);
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/my-progress`),
    );
  } finally {
    await clerk.signOut({ page });
  }
});
