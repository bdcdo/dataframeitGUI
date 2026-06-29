import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Smoke do dialog de sorteio v2 (spec 001, PR #179): seções de filtros,
// modos e participantes presentes, contagem de elegíveis ao vivo e prévia
// funcionando — tudo somente leitura (previewLottery não grava nada; o
// sorteio de fato não é executado para não mutar o projeto de teste).
// Requer credenciais de um coordenador e E2E_LOTTERY_PROJECT_ID — um
// projeto onde esse usuário é coordenador, com documentos e pelo menos um
// pesquisador (sem pesquisador a contagem de elegíveis não renderiza e o
// teste estoura por timeout em vez de pular — ver .env.e2e.example).
// Pulado se faltar qualquer um, para não quebrar CI sem o tenant de teste.
test("dialog de sorteio abre com filtros, modos e prévia funcionais", async ({
  page,
}) => {
  // Primeira visita compila /analyze/assignments no dev server — folga acima
  // dos 30s default para o teste não estourar durante o fluxo
  test.setTimeout(60_000);

  const identifier = process.env.E2E_COORDINATOR_EMAIL;
  const projectId = process.env.E2E_LOTTERY_PROJECT_ID;
  test.skip(
    !identifier || !projectId,
    "defina E2E_COORDINATOR_EMAIL e E2E_LOTTERY_PROJECT_ID em .env.e2e",
  );

  await setupClerkTestingToken({ page });

  await page.goto("/auth/login");
  // Estratégia ticket (token de sign-in criado server-side com a
  // CLERK_SECRET_KEY): dispensa senha e não esbarra na verificação de
  // "novo dispositivo" da instância, que bloqueia a estratégia password
  // em contexto headless (cada contexto Playwright é um dispositivo novo)
  await clerk.signIn({ page, emailAddress: identifier! });

  try {
    await page.goto(`/projects/${projectId}/analyze/assignments`);
    await page
      .getByRole("main")
      .getByRole("button", { name: "Sortear" })
      .click();

    const dialog = page.getByRole("dialog", { name: /Sortear/ });
    await expect(dialog).toBeVisible();

    // Seções do dialog v2
    await expect(
      dialog.getByRole("heading", { name: "Documentos elegíveis" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Atribuições pendentes" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Distribuição" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Participantes" }),
    ).toBeVisible();

    // Defaults dos modos novos: acrescentar + equilíbrio da rodada
    await expect(
      dialog.getByRole("radio", { name: "Acrescentar ao existente" }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("radio", { name: "Equilibrar só esta rodada" }),
    ).toBeChecked();

    // Seção Prazo não existe mais (US6 — guarda de regressão)
    await expect(dialog.getByText("Prazo", { exact: true })).toHaveCount(0);

    // Stats carregam e a contagem de elegíveis aparece
    await expect(dialog.getByText(/\d+ documentos elegíveis/)).toBeVisible({
      timeout: 15_000,
    });

    // Prévia computa e exibe totais + tabela por participante, sem coluna Prazo
    await dialog.getByRole("button", { name: "Visualizar prévia" }).click();
    await expect(dialog.getByText(/novas atribuições/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      dialog.getByRole("columnheader", { name: "Participante" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("columnheader", { name: "Prazo" }),
    ).toHaveCount(0);
  } finally {
    // signOut na própria página de atribuições trava no waitForFunction de
    // window.Clerk.loaded — fechar o dialog e voltar ao dashboard antes
    await page.keyboard.press("Escape");
    await page.goto("/dashboard");
    await clerk.signOut({ page });
  }
});
