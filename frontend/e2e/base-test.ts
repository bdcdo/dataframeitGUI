import { writeFileSync } from "node:fs";
import { test as base, type Response } from "@playwright/test";
import {
  classifyNotFound,
  describeNavigation,
  readRscPayload,
  type NavigationRecord,
} from "./navigation-diagnostics";

// `test` de todo spec E2E (os que mutam fixture o recebem por
// fixture-lock-test.ts, que estende este). O fixture automático registra as
// navegações do frame principal e as requests RSC do cliente; quando o teste
// falha, anexa a lista e imprime as que deram erro, já classificadas por
// navigation-diagnostics.ts. Sem isso o spec só mostra a própria mensagem
// ("confira o fixture e o reset"), que acusa o fixture mesmo quando o servidor
// nem casou a rota. `e2e-base-test-coverage.test.ts` exige este import.

function isTracked(response: Response): boolean {
  const request = response.request();
  if (request.isNavigationRequest()) {
    return response.frame() === response.frame().page().mainFrame();
  }
  // Navegação do cliente no App Router: fetch com header `rsc: 1`.
  return request.headers()["rsc"] === "1";
}

export const test = base.extend<{ navigationDiagnostics: void }>({
  // O Playwright exige desestruturar as dependências do fixture; o segundo
  // argumento é o `use` da API de fixtures, com outro nome pela mesma razão de
  // fixture-lock-test.ts (a regra de hooks do React o confundiria com `use`).
  navigationDiagnostics: [
    async ({ page }, provide, testInfo) => {
      const pending: Promise<NavigationRecord>[] = [];
      const onResponse = (response: Response) => {
        if (!isTracked(response)) return;
        pending.push(
          (async () => {
            const status = response.status();
            const headers: Record<string, string> = await response
              .allHeaders()
              .catch(() => ({}));
            // Só o corpo de erro interessa, e ele precisa ser lido já: depois
            // da navegação seguinte o Playwright pode não tê-lo mais.
            const body = status >= 400 ? await response.text().catch(() => "") : "";
            return {
              method: response.request().method(),
              url: response.url(),
              status,
              middlewareRewrite: headers["x-middleware-rewrite"] ?? null,
              clerkAuthReason: headers["x-clerk-auth-reason"] ?? null,
              ...readRscPayload(body),
            };
          })(),
        );
      };
      page.on("response", onResponse);
      await provide();
      page.off("response", onResponse);
      if (testInfo.status === testInfo.expectedStatus) return;

      const records = await Promise.all(pending);
      // Anexo por caminho, e não por `body`: o reporter `list` do pre-push só
      // imprime anexos que têm arquivo.
      const path = testInfo.outputPath("navegacoes.json");
      writeFileSync(
        path,
        JSON.stringify(
          records.map((r) => ({ ...r, origem404: classifyNotFound(r) })),
          null,
          2,
        ),
      );
      await testInfo.attach("navegacoes.json", { path, contentType: "application/json" });
      const failed = records.filter((r) => r.status >= 400);
      if (failed.length === 0) return;
      console.log(
        `[diagnóstico de navegação] ${testInfo.title}\n` +
          failed.map((r) => `  ${describeNavigation(r)}`).join("\n"),
      );
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
