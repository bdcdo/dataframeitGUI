import { test, expect, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import { withClerkCleanup } from "./clerk-cleanup";

test.describe.configure({ mode: "serial" });
const projectIds = (process.env.E2E_LLM_DECISIONS_PROJECT_IDS ?? "").split(",").filter(Boolean);

async function showAllCases(page: Page) {
  await page.getByRole("combobox", { name: "Status dos casos" }).click();
  await page.getByRole("option", { name: "Todos", exact: true }).click();
}

async function downloadCsv(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar CSV" }).click();
  const path = await (await downloading).path();
  expect(path).toBeTruthy();
  return Papa.parse<Record<string, string>>(await readFile(path!, "utf8"), { header: true, skipEmptyLines: true }).data;
}

for (const [index, mode] of ["compare_llm", "auto_review_llm"].entries()) {
  test(`decisões individuais: ${mode}, gabarito e arquivos persistidos`, async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    const projectId = projectIds[index];
    const email = process.env.E2E_COORDINATOR_EMAIL;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    test.skip(!projectId || !email || !url || !key, "Requer fixtures locais em E2E_LLM_DECISIONS_PROJECT_IDS.");
    expect(new URL(url!).hostname, "Este teste escreve somente no banco local de fixtures").toMatch(/^(localhost|127\.0\.0\.1)$/);
    const admin = createClient(url!, key!);
    const { data: project } = await admin.from("projects").select("name, automation_mode").eq("id", projectId).single();
    expect(project?.name).toBe(`LLM decision browser fixture ${mode}`);
    expect(project?.automation_mode).toBe(mode);
    const { data: doc } = await admin.from("documents").select("id").eq("project_id", projectId).eq("title", "Documento de teste de decisões").single();
    expect(doc).toBeTruthy();
    const docId = doc!.id as string;
    const { error: resetError } = await admin.from("error_resolutions").delete().eq("project_id", projectId).eq("document_id", docId);
    expect(resetError).toBeNull();
    const { data: originalResponses } = await admin.from("responses").select("id, answers").eq("project_id", projectId).order("id");

    await setupClerkTestingToken({ page });
    await page.goto("/auth/login");
    await clerk.signIn({ page, emailAddress: email! });
    await withClerkCleanup({ page, context: "llm-decisions", run: async () => {
      await page.goto(`/projects/${projectId}/reviews/llm-insights`);
      const card = page.getByRole("article", { name: "Documento de teste de decisões: Pergunta principal", exact: true });
      await expect(card).toBeVisible({ timeout: 30_000 });
      const exportPage = await context.newPage();
      await exportPage.goto(`/projects/${projectId}/config/documents`);
      await exportPage.getByRole("button", { name: "Gerar prévia" }).click();
      await expect(exportPage.getByText(/Prévia \(/)).toBeVisible();

      await card.getByRole("button", { name: "Erro humano", exact: true }).click();
      const confirm = page.getByRole("button", { name: "Confirmar decisão" });
      await expect(confirm).toBeEnabled();
      const { data: beforeConfirm } = await admin.from("error_resolutions").select("id").eq("project_id", projectId).eq("field_name", "x");
      expect(beforeConfirm).toEqual([]);
      await confirm.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.reload();
      await showAllCases(page);
      await expect(card.getByText("Erro humano", { exact: true })).toHaveCount(2);
      await page.screenshot({ path: testInfo.outputPath("llm-decisions.png"), fullPage: true });
      const contrasts = await card.evaluate((article) => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const luminance = (rgb: number[]) => rgb.slice(0, 3).map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
        return Array.from(article.querySelectorAll("p, button, code, [data-slot=badge]")).map((element) => {
          const chain: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
          ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1, 1);
          for (const node of chain) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
          const background = luminance(Array.from(ctx.getImageData(0, 0, 1, 1).data));
          ctx.fillStyle = getComputedStyle(element).color; ctx.fillRect(0, 0, 1, 1);
          const foreground = luminance(Array.from(ctx.getImageData(0, 0, 1, 1).data));
          return { text: element.textContent?.trim(), ratio: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) };
        }).filter((item) => item.text);
      });
      await testInfo.attach("contrastes", { body: JSON.stringify(contrasts), contentType: "application/json" });
      for (const item of contrasts) expect(item.ratio, item.text).toBeGreaterThanOrEqual(4.5);

      const csv = await downloadCsv(exportPage);
      const finalRow = csv.find((r) => r.source === "comparacao");
      expect(finalRow?.x).toBe("Resposta LLM");
      expect(finalRow?.reviewer_comments).toContain("[x] Erro humano");
      expect(finalRow?.other ?? "").toBe(mode === "compare_llm" ? "Outra humana" : "");
      expect(csv.filter((r) => r.source !== "comparacao").map((r) => r.x).sort()).toEqual(["Resposta LLM", "Resposta humana"].sort());
      await exportPage.getByRole("radio", { name: "XLSX" }).click();
      const downloading = exportPage.waitForEvent("download");
      await exportPage.getByRole("button", { name: "Baixar XLSX" }).click();
      const xlsxPath = await (await downloading).path();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(xlsxPath!);
      const sheet = workbook.getWorksheet("Gabarito")!;
      const headers = sheet.getRow(1).values as ExcelJS.CellValue[];
      expect(sheet.getRow(2).getCell(headers.indexOf("x")).text).toBe("Resposta LLM");
      await exportPage.goto(`/projects/${projectId}/reviews/gabarito`);
      await expect(exportPage.getByText("Erro humano", { exact: true })).toBeVisible();

      await card.getByRole("button", { name: "Erro do LLM", exact: true }).click();
      await page.getByRole("button", { name: "Confirmar decisão" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(async () => (await admin.from("error_resolutions").select("decision").eq("project_id", projectId).eq("field_name", "x").single()).data?.decision).toBe("researchers_correct");
      await card.getByRole("button", { name: "Em discussão", exact: true }).click();
      await page.getByRole("button", { name: "Confirmar decisão" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await exportPage.goto(`/projects/${projectId}/config/documents`);
      const discussionCsv = await downloadCsv(exportPage);
      const pendingRow = discussionCsv.find((r) => r.source === "comparacao");
      expect(pendingRow?.x).toBe("");
      expect(pendingRow?.reviewer_comments).toContain("[x] Em discussão");
      await card.getByRole("button", { name: "Reabrir", exact: true }).click();
      await page.getByRole("button", { name: "Confirmar reabertura" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const { data: afterReopen } = await admin.from("error_resolutions").select("id").eq("project_id", projectId).eq("document_id", docId);
      expect(afterReopen).toEqual([]);
      const { data: afterResponses } = await admin.from("responses").select("id, answers").eq("project_id", projectId).order("id");
      expect(afterResponses).toEqual(originalResponses);
      await exportPage.close();
    }});
  });
}
