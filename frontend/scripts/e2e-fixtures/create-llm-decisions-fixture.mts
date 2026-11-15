// Cria os dois projetos E2E do smoke de decisões do LLM Insights
// (frontend/e2e/llm-decisions.smoke.spec.ts) — um em `compare_llm`, outro em
// `auto_review_llm` — e imprime o E2E_LLM_DECISIONS_PROJECT_IDS para colar no
// .env.e2e. A ordem dos ids é a do spec: compare_llm, depois auto_review_llm.
//
// Versionado pelo mesmo motivo de create-coding-save-fixture.mts: sem a
// receita no repo, o spec só roda na máquina de quem montou a fixture à mão
// (#738).
//
// SÓ BANCO LOCAL. O spec grava e apaga `error_resolutions` e por isso recusa
// Supabase que não seja localhost; este script recusa pelo mesmo critério,
// para nunca criar projeto de teste no banco remoto.
//
// O que o spec lê, e por isso não pode mudar sem mudar o spec junto:
//   • nome `LLM decision browser fixture <modo>` e `automation_mode` = modo;
//   • documento "Documento de teste de decisões";
//   • campo `x` ("Pergunta principal"): LLM responde "Resposta LLM", o
//     pesquisador "Resposta humana", e o veredito fica com o pesquisador. É
//     esse veredito contra o LLM que põe o card na fila; "Erro humano" leva
//     "Resposta LLM" ao gabarito, e "Erro do LLM" parte de "Resposta humana";
//   • campo `other`: no fim do spec, a linha `comparacao` do CSV traz
//     "Outra humana" em compare_llm e branco em auto_review_llm. Em
//     compare_llm o revisor arbitrou `other` a favor do pesquisador; em
//     auto_review_llm o ciclo de `other` ainda espera a auto-revisão. É a prova
//     de que decidir `x` não mexe na célula vizinha.
//
// Idempotente: reutiliza os projetos pelo nome (o id não muda) e recria o
// documento, então rodar de novo devolve a fixture ao estado inicial — inclusive
// depois de um spec que morreu no meio.
//
// Rodar de frontend/, com o .env.e2e apontando para o Supabase local:
//   npm run e2e:fixture:llm-decisions
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  applyEnvironment,
  readEnvironmentFile,
  readOptionalEnvironmentFile,
} from "../worktree-env/env-contract.mjs";

// Mesmos arquivos, na mesma ordem de precedência e com o mesmo E2E_ENV_PATH,
// que o playwright.config.ts carrega: o projeto precisa nascer no banco que o
// spec vai ler.
const frontendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
applyEnvironment(process.env, readOptionalEnvironmentFile(join(frontendDir, ".env.local")));
applyEnvironment(
  process.env,
  process.env.E2E_ENV_PATH
    ? readEnvironmentFile(process.env.E2E_ENV_PATH)
    : readOptionalEnvironmentFile(join(frontendDir, ".env.e2e")),
  { override: true },
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
}
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname)) {
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL aponta para ${new URL(url).hostname}: esta fixture só é criada no Supabase local (ver E2E_ENV_PATH em .env.e2e.example)`,
  );
}
const COORDINATOR_EMAIL = process.env.E2E_COORDINATOR_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
if (!COORDINATOR_EMAIL || !MEMBER_EMAIL) {
  throw new Error("E2E_COORDINATOR_EMAIL / E2E_MEMBER_EMAIL ausentes (.env.e2e)");
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const MODES = ["compare_llm", "auto_review_llm"] as const;
type Mode = (typeof MODES)[number];
const DOC_TITLE = "Documento de teste de decisões";

// Hashes reais (`computeFieldHash`), como em create-coding-save-fixture.mts: o
// veredito vale pela versão da pergunta, e o banco carimba o hash do campo nas
// reviews e nos ciclos de auto-revisão.
const FIELDS = [
  {
    id: "e2e00000-0000-4000-8000-0000000007a1",
    hash: "2c8e8a29d69c",
    name: "x",
    type: "text",
    options: null,
    description: "Pergunta principal",
  },
  {
    id: "e2e00000-0000-4000-8000-0000000007a2",
    hash: "19cfd27d3e8f",
    name: "other",
    type: "text",
    options: null,
    description: "Outra pergunta",
  },
];
const ANSWER_FIELD_HASHES = Object.fromEntries(FIELDS.map((f) => [f.name, f.hash]));
const SCHEMA_HASH = "e2e-llm-decisions-schema-hash";
const LLM_ANSWERS = { x: "Resposta LLM", other: "Outra LLM" };
const HUMAN_ANSWERS = { x: "Resposta humana", other: "Outra humana" };

async function profileId(email: string): Promise<string> {
  const { data, error } = await supabase.from("profiles").select("id").eq("email", email).single();
  if (error || !data) throw new Error(`profile ${email}: ${error?.message}`);
  return data.id as string;
}

async function ensureProject(mode: Mode, coordId: string): Promise<string> {
  const name = `LLM decision browser fixture ${mode}`;
  const { data: existing, error: findError } = await supabase
    .from("projects")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (findError) throw new Error(`projects: ${findError.message}`);
  // O schema só é gravado na criação: o banco recusa avançar `schema_revision`
  // sem mudança de schema, e regravar os mesmos campos não muda nada. Para
  // mudar FIELDS, apague os projetos e rode de novo.
  if (existing) return existing.id as string;
  const { data, error } = await supabase
    .from("projects")
    .insert({
      pydantic_fields: FIELDS,
      pydantic_hash: SCHEMA_HASH,
      automation_mode: mode,
      name,
      description: "Fixture sintético do smoke de decisões do LLM Insights (#738). Pode ser apagado.",
      created_by: coordId,
      schema_version_major: 1,
      schema_version_minor: 0,
      schema_version_patch: 0,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert projects: ${error?.message}`);
  return data.id as string;
}

async function recreateDocument(projectId: string): Promise<string> {
  // Apagar e recriar, em vez de reaproveitar, é o que devolve respostas,
  // vereditos e ciclos ao estado inicial numa reexecução.
  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .eq("title", DOC_TITLE);
  if (deleteError) throw new Error(`delete documents: ${deleteError.message}`);
  const { data, error } = await supabase
    .from("documents")
    .insert({
      project_id: projectId,
      external_id: "E2E-LLM-DECISIONS-1",
      title: DOC_TITLE,
      text: "Texto sintético do documento de teste de decisões. ".repeat(20),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert documents: ${error?.message}`);
  return data.id as string;
}

async function insertResponse(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from("responses")
    .insert({
      ...row,
      answer_field_hashes: ANSWER_FIELD_HASHES,
      is_latest: true,
      is_partial: false,
      pydantic_hash: SCHEMA_HASH,
      schema_version_major: 1,
      schema_version_minor: 0,
      schema_version_patch: 0,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert responses: ${error?.message}`);
  return data.id as string;
}

async function seed(mode: Mode, coordId: string, memberId: string): Promise<string> {
  const projectId = await ensureProject(mode, coordId);
  for (const [userId, role] of [
    [coordId, "coordenador"],
    [memberId, "pesquisador"],
  ] as const) {
    const { error } = await supabase
      .from("project_members")
      .upsert({ project_id: projectId, user_id: userId, role }, { onConflict: "project_id,user_id" });
    if (error) throw new Error(`upsert project_members: ${error.message}`);
  }

  const documentId = await recreateDocument(projectId);
  const base = { project_id: projectId, document_id: documentId };
  const llmId = await insertResponse({
    ...base,
    respondent_type: "llm",
    respondent_name: "LLM",
    answers: LLM_ANSWERS,
    justifications: { x: "Justificativa sintética do LLM.", other: "Justificativa sintética do LLM." },
  });
  const humanId = await insertResponse({
    ...base,
    respondent_type: "humano",
    respondent_id: memberId,
    answers: HUMAN_ANSWERS,
  });

  if (mode === "compare_llm") {
    // O coordenador arbitrou as duas divergências na Comparação, a favor do
    // pesquisador.
    const { error } = await supabase.from("reviews").insert(
      FIELDS.map((f) => ({
        ...base,
        field_name: f.name,
        reviewer_id: coordId,
        verdict: HUMAN_ANSWERS[f.name as keyof typeof HUMAN_ANSWERS],
        chosen_response_id: humanId,
      })),
    );
    if (error) throw new Error(`insert reviews: ${error.message}`);
  } else {
    // Auto-revisão: em `x` o pesquisador contestou o LLM e o coordenador
    // arbitrou a favor dele; em `other` o ciclo espera a auto-revisão.
    const now = new Date().toISOString();
    const cycle = (fieldName: keyof typeof HUMAN_ANSWERS) => ({
      ...base,
      field_name: fieldName,
      human_response_id: humanId,
      llm_response_id: llmId,
      human_answer_snapshot: HUMAN_ANSWERS[fieldName],
      llm_answer_snapshot: LLM_ANSWERS[fieldName],
      self_reviewer_id: memberId,
    });
    const { error } = await supabase.from("field_reviews").insert([
      {
        ...cycle("x"),
        self_verdict: "contesta_llm",
        self_reviewed_at: now,
        self_justification: "O documento diz outra coisa.",
        arbitrator_id: coordId,
        blind_verdict: "humano",
        blind_decided_at: now,
        final_verdict: "humano",
        final_decided_at: now,
      },
      cycle("other"),
    ]);
    if (error) throw new Error(`insert field_reviews: ${error.message}`);
  }
  // A resposta do LLM enfileira a reconciliação da auto-revisão nos dois modos,
  // e o app a drena: em auto_review_llm criando exatamente os ciclos acima, em
  // compare_llm sem criar nada. Enquanto a request existe, a view
  // `final_answers` dá o documento como "aguarda reconciliação" e o card não
  // abre decisão; apagá-la é o estado pós-dreno.
  const { error: drainError } = await supabase
    .from("auto_review_reconciliation_requests")
    .delete()
    .eq("document_id", documentId);
  if (drainError) throw new Error(`delete auto_review_reconciliation_requests: ${drainError.message}`);
  return projectId;
}

const [coordId, memberId] = await Promise.all([profileId(COORDINATOR_EMAIL), profileId(MEMBER_EMAIL)]);
const ids: string[] = [];
for (const mode of MODES) {
  const id = await seed(mode, coordId, memberId);
  console.log(`${mode}: ${id}`);
  ids.push(id);
}
console.log(`\nE2E_LLM_DECISIONS_PROJECT_IDS=${ids.join(",")}`);
