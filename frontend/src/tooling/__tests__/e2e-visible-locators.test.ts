import type { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HIDDEN_INSENSITIVE_LOCATORS,
  LEGACY_SELECTOR_APIS,
} from "../../../eslint-rules/e2e-visible-locators.mjs";
import { frontendEslint, ruleLinter } from "@/test-utils/eslint-rule";

const ruleId = "no-restricted-syntax";
// A config typed, e não a base, porque é ela que o hook `lint-types` executa: a
// regra mora na base e só chega ao hook pelo `...base` da typed. Testar pela
// base deixaria passar o desacoplamento das duas, que tira o gate em silêncio.
const eslint = frontendEslint("eslint.config.typed.mjs");
const { messagesFor } = ruleLinter(eslint, ruleId, "e2e/example.spec.ts");

// Os imports só dão ao exemplo a forma de um spec; a regra não depende deles.
const prelude = `
  import { test, expect, type Page } from "@playwright/test";
  import { visivel } from "./visivel";
`;

describe("regra de locators visíveis nos specs E2E", () => {
  // A carga a frio da config (grafo do eslint-config-next) e o lint da pasta
  // e2e/ inteira ficam no beforeAll, fora do orçamento de CPU por teste
  // (docs/CODE_QUALITY_TOOLING.md), como o warmUp() de
  // @/test-utils/eslint-rule.
  let e2eFolderResults: ESLint.LintResult[] = [];
  beforeAll(async () => {
    e2eFolderResults = await eslint.lintFiles(["e2e/**/*.ts"]);
  }, 60_000);

  it.each(HIDDEN_INSENSITIVE_LOCATORS)(
    "bloqueia page.%s sem visivel()",
    async (method) => {
      const messages = await messagesFor(
        `${prelude}\ntest("x", async ({ page }) => { await expect(page.${method}("a")).toHaveCount(1); });`,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]?.message).toContain("visivel()");
    },
  );

  it.each(LEGACY_SELECTOR_APIS)(
    "bloqueia page.%s, que recebe seletor",
    async (method) => {
      const messages = await messagesFor(
        `${prelude}\ntest("x", async ({ page }) => { await page.${method}("text=a"); });`,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]?.message).toContain("API legada");
    },
  );

  // O hook roda o ESLint sem --max-warnings 0: rebaixada a "warn", a regra
  // continuaria aparecendo aqui e deixaria de barrar o push.
  it("é erro, não aviso", async () => {
    const [message] = await messagesFor(
      `${prelude}\ntest("x", async ({ page }) => { page.getByText("a"); });`,
    );

    expect(message?.severity).toBe(2);
  });

  // Helper fora de *.spec.ts também monta locator; estreitar o glob do bloco
  // tiraria esses arquivos do gate.
  it("vale para módulo de apoio, não só para spec", async () => {
    await expect(
      messagesFor(
        `${prelude}\nexport function x(page: Page) { return page.getByText("a"); }`,
        "e2e/helpers/navegacao.ts",
      ),
    ).resolves.toHaveLength(1);
  });

  it.each([
    [
      "página secundária",
      `const exportPage = await context.newPage(); exportPage.getByText("a");`,
    ],
    ["filtro depois do first()", `visivel(page.getByText("a").first());`],
    ["filtro depois do nth()", `visivel(page.getByPlaceholder("a").nth(1));`],
    [
      "locator guardado e filtrado depois",
      `const l = page.getByText("a"); visivel(l);`,
    ],
    [
      "outro wrapper que não visivel()",
      `expect(page.getByTestId("a")).toBeVisible();`,
    ],
    ["container achado por css", `page.locator("main").getByText("a");`],
    [
      "page object com this.page",
      `class Tela { constructor(private readonly page: Page) {} t() { return this.page.getByText("a"); } }`,
    ],
    [
      "body filtrado por visivel()",
      `visivel(page.locator("body")).getByText("a");`,
    ],
    [
      "html filtrado por visivel()",
      `visivel(page.locator(" html ")).locator("p");`,
    ],
  ])("bloqueia %s", async (_caseName, body) => {
    const messages = await messagesFor(
      `${prelude}\ntest("x", async ({ page, context }) => { ${body} });`,
    );

    expect(messages).toHaveLength(1);
  });

  it("permite locator filtrado, getByRole e o que parte de container por papel", async () => {
    await expect(
      messagesFor(`${prelude}
        test("x", async ({ page, context }) => {
          await expect(visivel(page.getByText("a"))).toBeVisible();
          await visivel(page.getByPlaceholder("a")).first().fill("x");
          await visivel(page.locator("button[data-x]")).nth(1).click();
          const exportPage = await context.newPage();
          await expect(visivel(exportPage.getByText("a"))).toBeVisible();
          const dialog = page.getByRole("dialog", { includeHidden: false });
          await expect(dialog.getByText("a")).toBeVisible();
          await page.getByRole("button", { name: "a" }).getByText("b").click();
          await expect(page.locator('a[href$="/x"]')).toHaveCount(0);
          await expect(page.getByText("a")).toHaveCount(0, { timeout: 1 });
        });
      `),
    ).resolves.toEqual([]);
  });

  it("bloqueia getByRole com includeHidden: true", async () => {
    const messages = await messagesFor(
      `${prelude}\ntest("x", async ({ page }) => { page.getByRole("button", { name: "a", includeHidden: true }); });`,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain("includeHidden");
  });

  // O callback roda no navegador, onde visivel() não alcança: um seletor do DOM
  // ali pega a primeira cópia, que pode ser a órfã do Suspense (desvio do #862).
  it.each([
    [
      "querySelector em page.evaluate",
      `await page.evaluate(() => document.querySelector("[data-testid=a]")!.getBoundingClientRect());`,
    ],
    [
      "querySelectorAll em page.waitForFunction",
      `await page.waitForFunction(() => document.querySelectorAll("button").length > 2);`,
    ],
    [
      "getElementById em page.evaluateHandle",
      `await page.evaluateHandle((id) => document.getElementById(id), "a");`,
    ],
    [
      "querySelector em locator.evaluateAll",
      `await visivel(page.getByText("a")).evaluateAll(() => document.querySelector("p"));`,
    ],
    [
      "querySelector num helper chamado pelo callback",
      `await page.evaluate(() => { const box = (s: string) => document.querySelector(s); return box("p"); });`,
    ],
  ])("bloqueia %s", async (_caseName, body) => {
    const messages = await messagesFor(
      `${prelude}\ntest("x", async ({ page }) => { ${body} });`,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain("dentro do navegador");
  });

  it("permite evaluate que não consulta o DOM por seletor", async () => {
    await expect(
      messagesFor(`${prelude}
        test("x", async ({ page }) => {
          await page.evaluate((key) => localStorage.getItem(key), "k");
          await page.evaluate(() => document.dispatchEvent(new Event("x")));
          await visivel(page.getByText("a")).evaluate((el) => el.querySelector("p"));
        });
      `),
    ).resolves.toEqual([]);
  });

  // Sem type-checker, a página é reconhecida pelo nome; estes casos provam que
  // renomear a página não é saída silenciosa da regra principal.
  it.each([
    [
      "página nova com outro nome",
      `test("x", async ({ context }) => { const tab = await context.newPage(); });`,
    ],
    ["parâmetro Page com outro nome", `async function go(p: Page) {}`],
    ["fixture renomeada", `test("x", async ({ page: p }) => {});`],
    [
      "popup com outro nome",
      `test("x", async ({ page }) => { const popup = await page.waitForEvent("popup"); });`,
    ],
    [
      "fixture tipada de test.extend com outro nome",
      `const t = test.extend<{ coordinator: Page }>({});`,
    ],
  ])("bloqueia %s", async (_caseName, code) => {
    const messages = await messagesFor(`${prelude}\n${code}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain("pelo nome");
  });

  it("aceita os nomes page e *Page", async () => {
    await expect(
      messagesFor(`${prelude}
        async function go(page: Page, otherPage: Page) {}
        test("x", async ({ page, context }) => {
          const exportPage = await context.newPage();
        });
      `),
    ).resolves.toEqual([]);
  });

  it("não se aplica fora de e2e/", async () => {
    await expect(
      messagesFor(
        `const page = { getByText: (x: string) => x }; page.getByText("a");`,
        "scripts/example.ts",
      ),
    ).resolves.toEqual([]);
  });

  // A regra só olha os arquivos tocados no pre-push; mudar a regra sem mexer nos
  // specs passaria sem relintar nenhum deles. Este caso relinta a pasta inteira.
  it("a pasta e2e/ inteira passa na regra", () => {
    const violations = e2eFolderResults.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === ruleId)
        .map((message) => `${result.filePath}:${message.line}`),
    );

    expect(e2eFolderResults.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
