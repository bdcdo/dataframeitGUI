import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient } from "@supabase/supabase-js";
import { withClerkCleanup } from "./clerk-cleanup";

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

function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

test("codificação: enviar respostas persiste response e conclui assignment", async ({
  page,
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

  const admin = createAdminClient();

  // Resolve o profile do membro e o documento do fixture pelo título — o
  // reset e as asserções de banco precisam dos dois ids.
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
  const { error: delErr } = await admin
    .from("responses")
    .delete()
    .eq("project_id", projectId!)
    .eq("document_id", documentId)
    .eq("respondent_id", memberId)
    .eq("respondent_type", "humano");
  expect(delErr, `reset de responses falhou: ${delErr?.message}`).toBeNull();
  const { error: assignErr } = await admin
    .from("assignments")
    .update({ status: "pendente", completed_at: null })
    .eq("project_id", projectId!)
    .eq("document_id", documentId)
    .eq("user_id", memberId)
    .eq("type", "codificacao");
  expect(assignErr, `reset do assignment falhou: ${assignErr?.message}`).toBeNull();

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
        page.getByText("Resumo do documento"),
        "pergunta 'Resumo do documento' não apareceu — confira o fixture e o reset",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Observação livre")).toBeVisible();

      // Campos text renderizam como Textarea com placeholder fixo
      // (FieldRenderer); a ordem na página segue a ordem dos campos no
      // schema do projeto: resumo (1ª) e observacao (2ª).
      const textareas = page.getByPlaceholder("Digite sua resposta...");
      await expect(textareas).toHaveCount(2);
      await textareas.nth(0).fill(RESUMO_VALUE);
      await textareas.nth(1).fill(OBSERVACAO_VALUE);

      await page.getByRole("button", { name: "Enviar respostas" }).click();
      await expect(
        page.getByText("Respostas salvas!"),
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
      const reloaded = page.getByPlaceholder("Digite sua resposta...");
      await expect(reloaded.nth(0)).toHaveValue(RESUMO_VALUE, {
        timeout: 30_000,
      });
      await expect(reloaded.nth(1)).toHaveValue(OBSERVACAO_VALUE);
    },
    // signOut direto na página de codificação pode travar no waitForFunction
    // de window.Clerk.loaded (mesmo padrão do lottery.smoke) — voltar ao
    // dashboard antes.
    prepareSignOut: async () => {
      await page.goto("/dashboard");
    },
  });
});
