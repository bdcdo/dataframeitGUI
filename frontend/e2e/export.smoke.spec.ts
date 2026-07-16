import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { withClerkCleanup } from "./clerk-cleanup";

// Smoke da feature 004 (exportação no topo de Documentos). Autentica como
// coordenador via login-por-ticket do Clerk (mesmo mecanismo do dashboard.smoke:
// sem senha, sem UI hospedada). Pulado quando faltam as envs de teste, como os
// demais smokes autenticados. Roda serial dentro do arquivo (mode default) para
// não reintroduzir o burst de signIn contra o tenant dev (issue #198).
test.describe.configure({ mode: "default" });

const hasClerkTestingEnv =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

test("exportação: card em Documentos, prévia, aba removida e rota 404", async ({
  page,
}) => {
  const email = process.env.E2E_COORDINATOR_EMAIL;
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !email || !projectId,
    "defina CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, E2E_COORDINATOR_EMAIL e E2E_PROJECT_ID",
  );

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email! });
  await withClerkCleanup({
    page,
    context: "export",
    run: async () => {
      await page.waitForFunction(
        () =>
          (window as unknown as { Clerk?: { session?: { status?: string } } })
            .Clerk?.session?.status === "active",
        { timeout: 15_000 },
      );

      // (a) Card de exportação presente na página Documentos.
      await page.goto(`/projects/${projectId}/config/documents`);
      await expect(page.getByText("Exportar documentos")).toBeVisible({
        timeout: 15_000,
      });

      // (b)+(d) Prévia sob demanda: cronometra do clique até a prévia (ou estado
      // vazio) aparecer; alvo SC-007 ≤ 10s.
      const start = Date.now();
      await page.getByRole("button", { name: "Gerar prévia" }).click();
      await expect(
        page.getByText(/Prévia \(|Nenhum documento para exportar/),
      ).toBeVisible({ timeout: 10_000 });
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(10_000);

      // (e) A aba "Exportar" não existe mais na navegação de Revisões.
      await page.goto(`/projects/${projectId}/reviews/gabarito`);
      await expect(page.locator('a[href$="/reviews/export"]')).toHaveCount(0);

      // (f) Acesso direto à rota antiga retorna not-found (404).
      const resp = await page.goto(`/projects/${projectId}/reviews/export`);
      expect(resp?.status()).toBe(404);
    },
  });
});
