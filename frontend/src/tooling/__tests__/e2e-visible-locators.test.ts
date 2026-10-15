import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { HIDDEN_INSENSITIVE_LOCATORS } from "../../../eslint.config.mjs";

const frontendRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ruleId = "no-restricted-syntax";
// A config typed, e não a base, porque é ela que o hook `lint-types` executa: a
// regra mora na base e só chega ao hook pelo `...base` da typed. Testar pela
// base deixaria passar o desacoplamento das duas, que tira o gate em silêncio.
const eslint = new ESLint({
  cwd: frontendRoot,
  overrideConfigFile: "eslint.config.typed.mjs",
});

async function messagesFor(code: string, filePath = "e2e/example.spec.ts") {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((message) => message.ruleId === ruleId) ?? [];
}

// Os imports só dão ao exemplo a forma de um spec; a regra não depende deles.
const prelude = `
  import { test, expect, type Page } from "@playwright/test";
  import { visivel } from "./visivel";
`;

describe("regra de locators visíveis nos specs E2E", () => {
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
    ["API legada $$", `await page.$$("text=a");`],
    [
      "API legada $$eval",
      `await page.$$eval("[data-testid=a]", (els) => els.length);`,
    ],
    ["API legada textContent", `await page.textContent("p");`],
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
  it("a pasta e2e/ inteira passa na regra", async () => {
    const results = await eslint.lintFiles(["e2e/**/*.ts"]);
    const violations = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === ruleId)
        .map((message) => `${result.filePath}:${message.line}`),
    );

    expect(results.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 60_000);
});
