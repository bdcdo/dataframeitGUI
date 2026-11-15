import { expect, type Route } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient } from "@supabase/supabase-js";
import { withClerkCleanup } from "./clerk-cleanup";
import { test } from "./fixture-lock-test";
import { visivel } from "./visivel";

// Smoke do fluxo de SALVAMENTO de codificação — proteção de regressão da
// família de bugs "codificação não salva" (#425, dedup de responses). O
// coração do spec é a asserção NO BANCO das duas pontas do par cuja
// dessincronia é o bug histórico: a linha de `responses` (is_latest,
// is_partial, answers) E o `assignments.status` — um toast de sucesso na UI
// não conta como prova de escrita.
//
// Diferente dos demais smokes (read-only), este MUTA o projeto de teste
// dedicado E2E_CODING_PROJECT_ID (criado por
// harness/2026-07-23-e2e-coding-fixture/create-fixture.mts, fora do repo):
// automation_mode='none', 2 campos text ("resumo"/"observacao"), 1 assignment
// de codificação do "Doc E2E save 1" para E2E_MEMBER_EMAIL. Para ser
// idempotente entre runs, o teste faz reset no banco ANTES de navegar —
// via service key (SUPABASE_SERVICE_ROLE_KEY, que playwright.config.ts já
// carrega de .env.local), um mecanismo que os specs existentes não usam:
// eles só leem a UI, este precisa preparar e inspecionar estado do Postgres
// em contexto Node.
//
// Autentica como PESQUISADOR (E2E_MEMBER_EMAIL) via login-por-ticket, como os
// demais smokes. Roda serial dentro do arquivo (mode default) — issue #198.
// Entre execuções simultâneas, quem serializa é o `holdFixtureLock`: os testes
// resetam a mesma response, e o segundo afirma que NENHUMA existe, o que a
// response recém-enviada por outro teste da outra execução desmente.
test.describe.configure({ mode: "default" });

const hasClerkTestingEnv =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const hasSupabaseAdminEnv =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESUMO_VALUE = "valor-e2e-resumo";
const OBSERVACAO_VALUE = "valor-e2e-observacao";
const DOC_TITLE = "Doc E2E save 1";
// Valor distinto dos acima: se algum dia vazar para o banco, o texto diz de
// qual caminho veio.
const UNSENT_VALUE = "valor-e2e-nao-enviado";

function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// Devolve o par do membro no documento ao estado inicial: sem response humana e
// com o assignment de codificação em "pendente". Só recebe ids já resolvidos
// pelo lookup de título exato de cada teste — é ele o interlock que impede este
// DELETE de cair num projeto real.
async function resetCodingFixture(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
  documentId: string,
  memberId: string,
) {
  const { error: delErr } = await admin
    .from("responses")
    .delete()
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", memberId)
    .eq("respondent_type", "humano");
  expect(delErr, `reset de responses falhou: ${delErr?.message}`).toBeNull();
  const { error: assignErr } = await admin
    .from("assignments")
    .update({ status: "pendente", completed_at: null })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", memberId)
    .eq("type", "codificacao");
  expect(assignErr, `reset do assignment falhou: ${assignErr?.message}`).toBeNull();
}

test("codificação: enviar respostas persiste response e conclui assignment", async ({
  page,
  holdFixtureLock,
}) => {
  // Primeira visita compila /analyze/code no dev server; o fluxo tem login +
  // submit + renavegação — folga bem acima dos 30s default.
  test.setTimeout(120_000);

  const email = process.env.E2E_MEMBER_EMAIL;
  const projectId = process.env.E2E_CODING_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !hasSupabaseAdminEnv || !email || !projectId,
    "defina CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, " +
      "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
      "E2E_MEMBER_EMAIL e E2E_CODING_PROJECT_ID",
  );
  await holdFixtureLock(projectId!);

  const admin = createAdminClient();

  // Resolve o profile do membro e o documento do fixture pelo título — o
  // reset e as asserções de banco precisam dos dois ids.
  //
  // O lookup por TÍTULO EXATO é o interlock de segurança deste spec, não uma
  // conveniência: o reset abaixo apaga linhas de `responses` com a service key
  // contra o banco de produção, a cada `git push`. Se E2E_CODING_PROJECT_ID
  // apontar para um projeto real (id colado errado, .env.e2e copiado de outra
  // máquina), nenhum documento se chama DOC_TITLE, o expect logo abaixo falha e
  // o teste aborta ANTES de qualquer DELETE. Não trocar por lookup posicional
  // (`.limit(1)`, primeiro doc do projeto): isso remove a trava e faz o raio do
  // DELETE passar a ser "qualquer projeto que o id apontar".
  const [{ data: member }, { data: doc }] = await Promise.all([
    admin.from("profiles").select("id").eq("email", email!).single(),
    admin
      .from("documents")
      .select("id")
      .eq("project_id", projectId!)
      .eq("title", DOC_TITLE)
      .single(),
  ]);
  expect(
    member,
    `profile de ${email} não encontrado — confira o fixture E2E_CODING_PROJECT_ID`,
  ).toBeTruthy();
  expect(
    doc,
    `documento "${DOC_TITLE}" não encontrado no projeto ${projectId}`,
  ).toBeTruthy();
  const memberId = member!.id as string;
  const documentId = doc!.id as string;

  // Reset idempotente: apaga as responses do membro no doc e devolve o
  // assignment a "pendente" — o run anterior (verde) deixa response
  // submetida + assignment concluído, e sem reset o doc nem apareceria na
  // fila padrão (filtro "current" esconde current_done).
  await resetCodingFixture(admin, projectId!, documentId, memberId);

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  // Estratégia ticket: dispensa senha e a verificação de "novo dispositivo"
  // da instância dev (ver lottery.smoke.spec.ts).
  await clerk.signIn({ page, emailAddress: email! });

  await withClerkCleanup({
    page,
    context: "coding-save",
    run: async () => {
      await page.goto(`/projects/${projectId}/analyze/code`);

      // Doc do fixture na fila de Atribuídos, com as duas perguntas do schema.
      await expect(
        visivel(page.getByText("Resumo do documento")),
        "pergunta 'Resumo do documento' não apareceu — confira o fixture e o reset",
      ).toBeVisible({ timeout: 30_000 });
      await expect(visivel(page.getByText("Observação livre"))).toBeVisible();

      // Campos text renderizam como Textarea com placeholder fixo
      // (FieldRenderer); a ordem na página segue a ordem dos campos no
      // schema do projeto: resumo (1ª) e observacao (2ª).
      const textareas = visivel(page.getByPlaceholder("Digite sua resposta..."));
      await expect(textareas).toHaveCount(2);
      await textareas.nth(0).fill(RESUMO_VALUE);
      await textareas.nth(1).fill(OBSERVACAO_VALUE);

      await page.getByRole("button", { name: "Enviar respostas" }).click();
      await expect(
        visivel(page.getByText("Respostas salvas!")),
        "toast de sucesso não apareceu após Enviar respostas",
      ).toBeVisible({ timeout: 15_000 });

      // === Coração do spec: asserção no BANCO. O toast acima só prova que a
      // Server Action retornou success; aqui provamos que ela ESCREVEU. O
      // saveResponse conclui o upsert e o sync do assignment ANTES de
      // retornar success, então a leitura é determinística (sem poll).
      const { data: response, error: respErr } = await admin
        .from("responses")
        .select("answers, is_latest, is_partial")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("respondent_id", memberId)
        .eq("respondent_type", "humano")
        .maybeSingle();
      expect(respErr, `leitura de responses falhou: ${respErr?.message}`).toBeNull();
      expect(
        response,
        "a UI reportou sucesso mas NENHUMA response foi escrita no banco — " +
          "regressão do salvamento de codificação",
      ).toBeTruthy();
      expect(response!.is_latest).toBe(true);
      expect(response!.is_partial).toBe(false);
      const answers = response!.answers as Record<string, unknown>;
      expect(answers.resumo).toBe(RESUMO_VALUE);
      expect(answers.observacao).toBe(OBSERVACAO_VALUE);

      const { data: assignment, error: readAssignErr } = await admin
        .from("assignments")
        .select("status, completed_at")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("user_id", memberId)
        .eq("type", "codificacao")
        .single();
      expect(
        readAssignErr,
        `leitura do assignment falhou: ${readAssignErr?.message}`,
      ).toBeNull();
      expect(
        assignment!.status,
        "response escrita mas assignment não concluiu — dessincronia do par " +
          "responses×assignments (família #425)",
      ).toBe("concluido");
      expect(assignment!.completed_at).toBeTruthy();

      // Round-trip pela UI: recarrega com ?round=all (o filtro padrão
      // "current" esconde docs concluídos da rodada atual) e confere que os
      // valores persistidos voltam pré-preenchidos no formulário.
      await page.goto(`/projects/${projectId}/analyze/code?round=all`);
      await page.getByRole("button", { name: new RegExp(DOC_TITLE) }).click();
      const reloaded = visivel(page.getByPlaceholder("Digite sua resposta..."));
      await expect(reloaded.nth(0)).toHaveValue(RESUMO_VALUE, {
        timeout: 30_000,
      });
      await expect(reloaded.nth(1)).toHaveValue(OBSERVACAO_VALUE);
    },
  });
});


// Contraparte do teste acima, e o discriminador do #608: prova que editar SEM
// enviar não produz escrita nenhuma no banco — e que o trabalho, mesmo assim,
// não se perde. Enquanto existia o salvamento automático, sair da tela gravava
// pelas costas (com `is_partial: true`, sem concluir o assignment); é essa
// escrita fantasma que o PR remove, e é a ausência dela que este teste fixa.
//
// Escrita-vs-exibição: a asserção que importa é a do banco. Ver o formulário
// repovoado só provaria que a tela lembra, não que o servidor foi (ou não foi)
// tocado.
test("codificação: editar e sair sem enviar não grava, e o rascunho local retém", async ({
  page,
  holdFixtureLock,
}) => {
  test.setTimeout(120_000);

  const email = process.env.E2E_MEMBER_EMAIL;
  const projectId = process.env.E2E_CODING_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !hasSupabaseAdminEnv || !email || !projectId,
    "mesmas variáveis do teste acima",
  );
  await holdFixtureLock(projectId!);

  const admin = createAdminClient();
  const [{ data: member }, { data: doc }] = await Promise.all([
    admin.from("profiles").select("id").eq("email", email!).single(),
    admin
      .from("documents")
      .select("id")
      .eq("project_id", projectId!)
      .eq("title", DOC_TITLE)
      .single(),
  ]);
  // Mesmo interlock do teste acima: sem o documento de título exato, aborta
  // antes do DELETE.
  expect(member).toBeTruthy();
  expect(doc, `documento "${DOC_TITLE}" não encontrado`).toBeTruthy();
  const memberId = member!.id as string;
  const documentId = doc!.id as string;

  await resetCodingFixture(admin, projectId!, documentId, memberId);

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email! });

  await withClerkCleanup({
    page,
    context: "coding-save-unsent",
    run: async () => {
      await page.goto(`/projects/${projectId}/analyze/code`);
      await expect(visivel(page.getByText("Resumo do documento"))).toBeVisible({
        timeout: 30_000,
      });

      const textareas = visivel(page.getByPlaceholder("Digite sua resposta..."));
      await expect(textareas).toHaveCount(2);
      await textareas.nth(0).fill(UNSENT_VALUE);

      // A edição acende o indicador permanente.
      await expect(visivel(page.getByText("Alterações não enviadas")).first()).toBeVisible();

      // Esconder a aba é o gatilho que o autosave usava para gravar por
      // `sendBeacon` (`visibilitychange` → hidden). Simulá-lo aqui é o que
      // torna a asserção de banco lá embaixo DISCRIMINANTE: sem este passo,
      // "nenhuma response" passaria mesmo com o autosave de volta, porque
      // nenhum dos quatro gatilhos cobria navegação SPA — o buraco que motivou
      // a issue. Com ele, reintroduzir o hook deixa o teste vermelho.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Provar AUSÊNCIA de escrita exige esperar a janela em que ela
      // aconteceria. Medi que sem isto o teste era enganoso: com o gatilho
      // reintroduzido, a Server Action gravava — mas depois da leitura, e a
      // asserção passava verde sobre um banco que estava prestes a mudar.
      // `networkidle` ancora a espera na request real, em vez de num
      // `waitForTimeout` arbitrário.
      await page.waitForLoadState("networkidle");

      // Sair pela aba do projeto — a navegação SPA que o autosave NUNCA cobriu,
      // e que era o buraco central do mecanismo removido.
      await page.getByRole("link", { name: "Revisar" }).click();

      const dialog = page.getByRole("alertdialog");
      await expect(
        dialog,
        "sair com alterações não enviadas deveria pedir confirmação",
      ).toBeVisible();

      // "Ficar" mantém a pessoa na tela, com o texto preservado.
      await dialog.getByRole("button", { name: "Ficar" }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(/\/analyze\/code/);
      await expect(textareas.nth(0)).toHaveValue(UNSENT_VALUE);

      // Agora sair de fato.
      await page.getByRole("link", { name: "Revisar" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Sair sem enviar" })
        .click();
      await expect(page).toHaveURL(/\/reviews/, { timeout: 15_000 });

      // === Coração deste spec: NADA foi escrito. Antes do #608, chegar até
      // aqui deixava uma response parcial no banco sem que ninguém pedisse.
      const { data: rows, error: readErr } = await admin
        .from("responses")
        .select("id")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("respondent_id", memberId)
        .eq("respondent_type", "humano");
      expect(readErr, `leitura de responses falhou: ${readErr?.message}`).toBeNull();
      expect(
        rows ?? [],
        "editar sem enviar gravou no banco — algum gatilho de salvamento " +
          "automático voltou (a aba foi escondida acima justamente para " +
          "acordar o `visibilitychange`)",
      ).toHaveLength(0);

      // O assignment também não avançou.
      const { data: assignment } = await admin
        .from("assignments")
        .select("status")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("user_id", memberId)
        .eq("type", "codificacao")
        .maybeSingle();
      expect(assignment!.status).toBe("pendente");

      // E o trabalho não se perdeu: de volta à codificação, a faixa oferece o
      // rascunho. É a metade que justifica a outra — remover a gravação
      // automática só é seguro porque esta rede existe.
      await page.goto(`/projects/${projectId}/analyze/code`);
      await expect(
        page.getByRole("button", { name: "Retomar rascunho" }),
        "o rascunho local não foi oferecido de volta",
      ).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Retomar rascunho" }).click();
      await expect(
        visivel(page.getByPlaceholder("Digite sua resposta...")).nth(0),
      ).toHaveValue(UNSENT_VALUE);

      // Segunda leitura, no fim de tudo: a primeira mede a janela imediata, esta
      // fecha a porta para uma escrita atrasada — inclusive a que só apareceria
      // depois do round-trip de voltar à tela.
      const { data: after } = await admin
        .from("responses")
        .select("id")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("respondent_id", memberId)
        .eq("respondent_type", "humano");
      expect(
        after ?? [],
        "uma escrita apareceu no banco depois do fluxo — nenhum caminho desta " +
          "tela deve gravar sem o envio explícito",
      ).toHaveLength(0);
    },
  });
});

// Argumentos de uma chamada de Server Action, lidos do corpo da request. O
// React serializa argumentos simples (strings e objetos planos) como um array
// JSON — `["<projectId>","<documentId>",{...answers},{...opts}]` para o
// `saveResponse`. Qualquer outro corpo (FormData, texto que não é array) devolve
// null e passa intocado.
function parseActionArgs(body: string | null): unknown[] | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Fixa a invariante que o #626 deixou com um guarda só (#636): um envio
// INCOMPLETO sobre um assignment já `concluido` rebaixa `responses.is_partial`,
// mas não rebaixa o assignment. Os dois sinais divergem de propósito — o
// conjunto gravado deixou de estar completo, mas a conclusão foi um ato da
// pesquisadora e só ela a desfaz. Quem sustenta a segunda metade é o guard de
// `keepCodingAssignmentInProgress` (lib/coding-sync.ts), que nunca regride de
// `concluido`. Afirmar só um dos sinais deixaria passar metade da regressão.
//
// Como o envio incompleto chega ao servidor: pela tela não chega, porque o
// `SubmitBar` barra o clique enquanto houver obrigatória em branco. Em produção
// ele acontece quando o schema muda entre abrir o formulário e enviar (#519) — o
// cliente defasado manda um conjunto que o servidor já não considera completo.
// Este teste reproduz esse payload na fronteira de rede: a tela envia o
// formulário completo e a interceptação apaga a resposta de `observacao` antes
// de a request sair do navegador. O que vem depois é o caminho real de
// produção — Server Action, régua de completude, sync do assignment e banco —,
// sem mexer no schema do projeto fixture, que os outros dois testes leem.
test("codificação: envio incompleto rebaixa is_partial mas não regride assignment concluído", async ({
  page,
  holdFixtureLock,
}) => {
  // Dois envios e duas navegações: folga acima dos outros testes do arquivo.
  test.setTimeout(180_000);

  const email = process.env.E2E_MEMBER_EMAIL;
  const projectId = process.env.E2E_CODING_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !hasSupabaseAdminEnv || !email || !projectId,
    "mesmas variáveis do primeiro teste",
  );
  await holdFixtureLock(projectId!);

  const admin = createAdminClient();
  const [{ data: member }, { data: doc }] = await Promise.all([
    admin.from("profiles").select("id").eq("email", email!).single(),
    admin
      .from("documents")
      .select("id")
      .eq("project_id", projectId!)
      .eq("title", DOC_TITLE)
      .single(),
  ]);
  // Mesmo interlock do primeiro teste: sem o documento de título exato, aborta
  // antes do DELETE.
  expect(member).toBeTruthy();
  expect(doc, `documento "${DOC_TITLE}" não encontrado`).toBeTruthy();
  const memberId = member!.id as string;
  const documentId = doc!.id as string;

  await resetCodingFixture(admin, projectId!, documentId, memberId);

  const readResponse = () =>
    admin
      .from("responses")
      .select("answers, is_latest, is_partial")
      .eq("project_id", projectId!)
      .eq("document_id", documentId)
      .eq("respondent_id", memberId)
      .eq("respondent_type", "humano")
      .maybeSingle();
  const readAssignment = () =>
    admin
      .from("assignments")
      .select("status, completed_at")
      .eq("project_id", projectId!)
      .eq("document_id", documentId)
      .eq("user_id", memberId)
      .eq("type", "codificacao")
      .single();

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email! });

  // O estado que este teste deixa — assignment `concluido` com response
  // `is_partial = true` — é o que a invariante
  // `codificacao-concluida-response-so-rascunho` (scripts/invariants) lê como
  // rascunho promovido a concluído. Devolver o fixture ao estado inicial no fim
  // evita que cada pre-push plante essa violação no banco.
  try {
    await withClerkCleanup({
      page,
      context: "coding-save-incomplete",
      run: async () => {
        // 1. Codifica por completo e envia: o assignment nasce `concluido`.
        await page.goto(`/projects/${projectId}/analyze/code`);
        await expect(visivel(page.getByText("Resumo do documento"))).toBeVisible({
          timeout: 30_000,
        });
        const textareas = visivel(page.getByPlaceholder("Digite sua resposta..."));
        await expect(textareas).toHaveCount(2);
        await textareas.nth(0).fill(RESUMO_VALUE);
        await textareas.nth(1).fill(OBSERVACAO_VALUE);
        await page.getByRole("button", { name: "Enviar respostas" }).click();
        await expect(visivel(page.getByText("Respostas salvas!"))).toBeVisible({
          timeout: 15_000,
        });

        // Pré-condição no banco: sem ela, a asserção final não distingue "não
        // regrediu" de "nunca concluiu".
        const { data: complete, error: completeErr } = await readResponse();
        expect(completeErr, `leitura de responses falhou: ${completeErr?.message}`).toBeNull();
        expect(complete?.is_partial, "o primeiro envio, completo, ficou parcial").toBe(false);
        const { data: concluded, error: concludedErr } = await readAssignment();
        expect(
          concludedErr,
          `leitura do assignment falhou: ${concludedErr?.message}`,
        ).toBeNull();
        expect(concluded!.status, "o primeiro envio, completo, não concluiu").toBe(
          "concluido",
        );
        const completedAt = concluded!.completed_at as string;
        expect(completedAt).toBeTruthy();

        // 2. Reabre o documento. Concluído na rodada atual, ele sai da fila de
        // Atribuídos; o `?doc=` o abre no modo Explorar, editável (o filtro
        // `?round=all` abriria somente leitura).
        let rewrites = 0;
        const codePage = (url: URL) =>
          url.pathname === `/projects/${projectId}/analyze/code`;
        const blankObservacao = async (route: Route) => {
          const request = route.request();
          const args =
            request.method() === "POST" && request.headers()["next-action"]
              ? parseActionArgs(request.postData())
              : null;
          const answers = args?.[2];
          if (
            args?.[0] === projectId &&
            args?.[1] === documentId &&
            typeof answers === "object" &&
            answers !== null &&
            "observacao" in answers
          ) {
            // O que uma textarea apagada envia.
            (answers as Record<string, unknown>).observacao = "";
            await route.continue({ postData: JSON.stringify(args) });
            rewrites += 1;
            return;
          }
          await route.continue();
        };
        await page.route(codePage, blankObservacao);

        await page.goto(`/projects/${projectId}/analyze/code?doc=${documentId}`);
        const reopened = visivel(page.getByPlaceholder("Digite sua resposta..."));
        await expect(reopened.nth(0)).toHaveValue(RESUMO_VALUE, { timeout: 30_000 });
        await expect(reopened.nth(1)).toHaveValue(OBSERVACAO_VALUE);
        await page.getByRole("button", { name: "Enviar respostas" }).click();

        // A reescrita vem antes do aviso: se o formato do corpo mudar, é esta a
        // mensagem que diz por quê, e não o timeout genérico do aviso. Depois
        // dela a interceptação sai, para não apagar nenhum envio seguinte.
        await expect
          .poll(() => rewrites, {
            message:
              "a interceptação não reescreveu o envio: o corpo da Server Action " +
              "deixou de ser o array JSON de argumentos que parseActionArgs lê",
            timeout: 15_000,
          })
          .toBe(1);
        await page.unroute(codePage, blankObservacao);

        // O servidor viu o conjunto incompleto e o disse: o aviso nomeia a
        // pergunta que ficou em branco. Ancora a leitura do banco na resposta da
        // Server Action, que só volta depois do upsert e do sync do assignment.
        await expect(
          visivel(page.getByText('Salvo — falta responder "Observação livre"')),
          "o servidor não acusou a obrigatória em branco — o envio chegou completo?",
        ).toBeVisible({ timeout: 15_000 });

        // 3. Coração do teste: os dois sinais, no banco.
        const { data: response, error: respErr } = await readResponse();
        expect(respErr, `leitura de responses falhou: ${respErr?.message}`).toBeNull();
        expect(response, "nenhuma response is_latest depois do envio incompleto").toBeTruthy();
        expect(response!.is_latest).toBe(true);
        const answers = response!.answers as Record<string, unknown>;
        expect(answers.resumo).toBe(RESUMO_VALUE);
        expect(answers.observacao ?? "", "o envio incompleto não foi gravado").toBe("");
        expect(
          response!.is_partial,
          "o conjunto gravado ficou incompleto mas is_partial continuou false",
        ).toBe(true);

        const { data: assignment, error: readAssignErr } = await readAssignment();
        expect(
          readAssignErr,
          `leitura do assignment falhou: ${readAssignErr?.message}`,
        ).toBeNull();
        expect(
          assignment!.status,
          "envio incompleto regrediu o assignment concluído — o guard de " +
            "keepCodingAssignmentInProgress (lib/coding-sync.ts) deixou de " +
            "segurar a invariante (#636)",
        ).toBe("concluido");
        expect(
          new Date(assignment!.completed_at as string).getTime(),
          "o envio incompleto reescreveu completed_at do assignment concluído",
        ).toBe(new Date(completedAt).getTime());
      },
    });
  } finally {
    await resetCodingFixture(admin, projectId!, documentId, memberId);
  }
});
