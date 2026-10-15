import { test, expect, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { withClerkCleanup } from "./clerk-cleanup";
import {
  COMPARE_SPLIT_COOKIE,
  LEGACY_SPLIT_STORAGE_KEY,
  READER_PANEL_ID,
  REVIEW_PANEL_ID,
} from "../src/lib/compare-split-layout";

// A divisão leitor/revisão da Comparação tem de sair já certa no HTML do
// servidor. Dois defeitos medidos motivam o spec:
//
// 1. `defaultSize={50}` na react-resizable-panels v4 é PIXEL, não percentual.
//    O servidor desenhava os dois painéis com 50px e a tela saltava na
//    hidratação (CLS 0,11 em build de produção, layout errado visível por
//    330-510 ms).
// 2. A divisão salva vivia em localStorage, que o servidor não lê. O cliente
//    hidratava com a salva, o servidor tinha renderizado a padrão, e o React 19
//    não corrige atributo divergente na hidratação: quem arrastou o divisor
//    via, ao recarregar, os dois painéis presos em 50px.
//
// Como medir "antes da hidratação" sem depender de timing: a mesma página é
// carregada com os scripts bloqueados, o que deixa na tela exatamente o HTML e
// o CSS do servidor. Depois carrega normal e mede quando o grupo de painéis já
// montou. As duas medidas têm de coincidir.
//
// Só lê o projeto do fixture da Comparação; não escreve no banco.
test.describe.configure({ mode: "default" });

const hasClerkTestingEnv =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

interface SplitBoxes {
  readerWidth: number;
  reviewX: number;
  reviewWidth: number;
  firstCardTop: number | null;
}

function skipUnlessConfigured() {
  const email = process.env.E2E_COORDINATOR_EMAIL;
  const projectId = process.env.E2E_COMPARE_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !email || !projectId,
    "defina CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, " +
      "E2E_COORDINATOR_EMAIL e E2E_COMPARE_PROJECT_ID",
  );
  return { email: email!, projectId: projectId! };
}

async function measure(page: Page): Promise<SplitBoxes> {
  // Os painéis da lib expõem o próprio `id` como `data-testid`.
  return page.evaluate(
    ([readerId, reviewId]) => {
      const box = (testId: string) =>
        document
          .querySelector(`[data-testid="${testId}"]`)!
          .getBoundingClientRect();
      const reader = box(readerId);
      const review = box(reviewId);
      const card = document.querySelector("button[data-vote-target]");
      return {
        readerWidth: Math.round(reader.width),
        reviewX: Math.round(review.x),
        reviewWidth: Math.round(review.width),
        firstCardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      };
    },
    [READER_PANEL_ID, REVIEW_PANEL_ID],
  );
}

/** Layout que o servidor entrega: a página carregada sem executar script. */
async function measureServerHtml(page: Page, url: string): Promise<SplitBoxes> {
  const block = (route: import("@playwright/test").Route) =>
    route.request().resourceType() === "script"
      ? route.abort()
      : route.fallback();
  await page.route("**/*", block);
  try {
    await page.goto(url);
    await expect(page.getByTestId(REVIEW_PANEL_ID)).toBeVisible({
      timeout: 60_000,
    });
    return await measure(page);
  } finally {
    await page.unroute("**/*", block);
  }
}

/**
 * Espera o grupo de painéis montar no cliente. O separador só ganha
 * `aria-valuenow` quando a lib publica o layout calculado, e os painéis
 * assinam a mesma publicação. Esperar só a hidratação não basta: entre ela e
 * a montagem do grupo o DOM ainda é o do servidor, e a comparação passaria
 * por acidente.
 */
async function waitForMountedSplit(page: Page): Promise<void> {
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    /\d/,
    { timeout: 60_000 },
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function measureHydrated(page: Page, url: string): Promise<SplitBoxes> {
  await page.goto(url);
  await waitForMountedSplit(page);
  return measure(page);
}

/** Esquece qualquer divisão salva, nos dois lugares em que ela já morou. */
async function forgetSavedSplit(page: Page): Promise<void> {
  await page.context().clearCookies({ name: COMPARE_SPLIT_COOKIE });
  await page.evaluate((key) => localStorage.removeItem(key), LEGACY_SPLIT_STORAGE_KEY);
}

async function signedIn(page: Page, email: string): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/dashboard");
}

/** Arrasta o divisor `dx` pixels na horizontal (negativo = para a esquerda). */
async function dragHandle(page: Page, dx: number): Promise<void> {
  const handle = (await page.getByRole("separator").boundingBox())!;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(handle.x + dx, y, { steps: 10 });
  await page.mouse.up();
}

/** Participação da revisão na largura dos dois painéis, em pontos percentuais. */
async function reviewShare(page: Page): Promise<number> {
  const m = await measure(page);
  return Math.round((100 * m.reviewWidth) / (m.readerWidth + m.reviewWidth));
}

/** Divisão gravada no cookie, como o servidor a leria. */
async function savedCookieSplit(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  const found = cookies.find((c) => c.name === COMPARE_SPLIT_COOKIE);
  return found ? decodeURIComponent(found.value) : null;
}

// Tolerância de 1px: arredondamento subpixel, e o separador de 1px dividido
// entre os dois painéis. O defeito medido era de centenas de pixels.
function expectSameSplit(server: SplitBoxes, client: SplitBoxes) {
  const detail = `servidor ${JSON.stringify(server)} x cliente ${JSON.stringify(client)}`;
  expect(Math.abs(server.readerWidth - client.readerWidth), detail).toBeLessThanOrEqual(1);
  expect(Math.abs(server.reviewX - client.reviewX), detail).toBeLessThanOrEqual(1);
  expect(Math.abs(server.reviewWidth - client.reviewWidth), detail).toBeLessThanOrEqual(1);
  expect(server.firstCardTop, detail).not.toBeNull();
  expect(Math.abs(server.firstCardTop! - client.firstCardTop!), detail).toBeLessThanOrEqual(1);
}

test("comparação: sem divisão salva, o HTML do servidor já sai 50/50", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();
  const url = `/projects/${projectId}/analyze/compare?queue=all`;
  await signedIn(page, email);

  await withClerkCleanup({
    page,
    context: "compare-split-layout/padrao",
    run: async () => {
      await forgetSavedSplit(page);
      const server = await measureServerHtml(page, url);
      await forgetSavedSplit(page);
      const client = await measureHydrated(page, url);

      expectSameSplit(server, client);
      // E a divisão é de fato meio a meio, não só igual nos dois momentos.
      expect(
        Math.abs(client.readerWidth - client.reviewWidth),
        JSON.stringify(client),
      ).toBeLessThanOrEqual(2);
    },
  });
});

test("comparação: divisão arrastada volta igual ao recarregar, já no HTML do servidor", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();
  const url = `/projects/${projectId}/analyze/compare?queue=all`;
  await signedIn(page, email);

  await withClerkCleanup({
    page,
    context: "compare-split-layout/arrastada",
    run: async () => {
      await forgetSavedSplit(page);
      const initial = await measureHydrated(page, url);

      // Arrasta o divisor 200px para a esquerda: a revisão fica mais larga.
      await dragHandle(page, -200);
      await expect
        .poll(async () => (await measure(page)).reviewWidth)
        .toBeGreaterThan(initial.reviewWidth + 150);
      const dragged = await measure(page);

      const server = await measureServerHtml(page, url);
      expectSameSplit(dragged, server);
      const client = await measureHydrated(page, url);
      expectSameSplit(dragged, client);
    },
  });
});

test("comparação: divisão salva no localStorage antigo migra para o cookie", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();
  const url = `/projects/${projectId}/analyze/compare?queue=all`;
  await signedIn(page, email);

  await withClerkCleanup({
    page,
    context: "compare-split-layout/migracao",
    run: async () => {
      await forgetSavedSplit(page);
      // Exatamente o que o `useDefaultLayout` gravava até a troca para cookie.
      await page.evaluate(
        ([key, readerId, reviewId]) =>
          localStorage.setItem(key, JSON.stringify({ [readerId]: 30, [reviewId]: 70 })),
        [LEGACY_SPLIT_STORAGE_KEY, READER_PANEL_ID, REVIEW_PANEL_ID] as const,
      );

      await page.goto(url);
      await waitForMountedSplit(page);
      await expect.poll(() => reviewShare(page)).toBe(70);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), LEGACY_SPLIT_STORAGE_KEY),
        "a chave antiga deveria ser apagada depois de migrada",
      ).toBeNull();
      const migrated = await measure(page);

      // A carga seguinte já vem do cookie, sem passar pelo cliente.
      const server = await measureServerHtml(page, url);
      expectSameSplit(migrated, server);
    },
  });
});

test("comparação: voltar pelo histórico não apaga a divisão salva", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();
  const url = `/projects/${projectId}/analyze/compare?queue=all`;
  await signedIn(page, email);

  await withClerkCleanup({
    page,
    context: "compare-split-layout/historico",
    run: async () => {
      await forgetSavedSplit(page);
      await page.goto(url);
      await waitForMountedSplit(page);
      await dragHandle(page, -200);
      await expect.poll(() => reviewShare(page)).toBeGreaterThan(60);
      const share = await reviewShare(page);
      const saved = await savedCookieSplit(page);
      expect(saved).not.toBeNull();

      // Sai por navegação de cliente e volta pelo histórico. O Next reaproveita
      // o payload RSC em cache, que traz a divisão lida na carga ANTERIOR ao
      // arraste; o grupo remonta com ela. Antes da correção, a gravação da
      // montagem sobrescrevia o cookie com esse valor velho e a preferência
      // se perdia de vez.
      await page.getByRole("link", { name: "AC" }).first().click();
      await page.waitForURL("**/dashboard");
      await page.goBack();
      await waitForMountedSplit(page);

      await expect.poll(() => reviewShare(page)).toBe(share);
      expect(await savedCookieSplit(page)).toBe(saved);
    },
  });
});

test("comparação: o divisor para no mínimo de 25% do painel", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();
  const url = `/projects/${projectId}/analyze/compare?queue=all`;
  await signedIn(page, email);

  await withClerkCleanup({
    page,
    context: "compare-split-layout/minimo",
    run: async () => {
      await forgetSavedSplit(page);
      await page.goto(url);
      await waitForMountedSplit(page);
      // Muito além da borda: só o `minSize` segura o leitor. Com o número
      // tratado como pixel o leitor descia a ~2% da largura.
      await dragHandle(page, -2000);
      await expect.poll(() => reviewShare(page)).toBe(75);
    },
  });
});

test("comparação: com cookie presente, a chave antiga do localStorage é descartada sem aplicar", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();
  const url = `/projects/${projectId}/analyze/compare?queue=all`;
  await signedIn(page, email);

  await withClerkCleanup({
    page,
    context: "compare-split-layout/precedencia",
    run: async () => {
      await forgetSavedSplit(page);
      const cookieValue = JSON.stringify({ [READER_PANEL_ID]: 40, [REVIEW_PANEL_ID]: 60 });
      await page.context().addCookies([
        {
          name: COMPARE_SPLIT_COOKIE,
          value: encodeURIComponent(cookieValue),
          url: new URL(page.url()).origin,
        },
      ]);
      await page.evaluate(
        ([key, readerId, reviewId]) =>
          localStorage.setItem(key, JSON.stringify({ [readerId]: 30, [reviewId]: 70 })),
        [LEGACY_SPLIT_STORAGE_KEY, READER_PANEL_ID, REVIEW_PANEL_ID] as const,
      );

      await page.goto(url);
      await waitForMountedSplit(page);
      // Folga para um `setLayout` tardio da migração aparecer, se existir.
      await page.waitForTimeout(500);
      expect(await reviewShare(page)).toBe(60);
      expect(await savedCookieSplit(page)).toBe(cookieValue);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), LEGACY_SPLIT_STORAGE_KEY),
      ).toBeNull();
    },
  });
});
