// Cria os dois projetos E2E do smoke de decisões do LLM Insights
// (frontend/e2e/llm-decisions.smoke.spec.ts) — um em `compare_llm`, outro em
// `auto_review_llm` — e imprime o E2E_LLM_DECISIONS_PROJECT_IDS para colar no
// .env.e2e. A ordem dos ids é a do spec: compare_llm, depois auto_review_llm.
//
// Versionado pelo mesmo motivo de create-coding-save-fixture.mts: sem a
// receita no repo, o spec só roda na máquina de quem montou a fixture à mão
// (#738).
//
// SÓ BANCO LOCAL, pelo mesmo critério do spec (ver .env.e2e.example).
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
//     auto_review_llm o pesquisador o marcou como ambíguo. É a prova de que
//     decidir `x` não mexe na célula vizinha.
//
// Idempotente: reutiliza os projetos pelo nome (o id não muda) e recria o
// documento, então rodar de novo devolve a fixture ao estado inicial — inclusive
// depois de um spec que morreu no meio.
//
// Rodar de frontend/, com E2E_ENV_PATH apontando para o env do Supabase local
// (ver .env.e2e.example):
//   E2E_ENV_PATH=<arquivo> npm run e2e:fixture:llm-decisions
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { acquireFixtureLock, defaultFixtureLockDir, fixtureLockWaitMs } from "../../e2e/fixture-lock";
import { fieldHashOf } from "../../src/lib/schema-utils";
import { loadE2eEnvironment } from "../worktree-env/env-contract.mjs";
import { sameStoredFields } from "./fixture-schema";

// O mesmo ambiente que o playwright.config.ts carrega, inclusive o
// E2E_ENV_PATH (ver loadE2eEnvironment): a fixture nasce no banco que o spec lê.
const frontendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
loadE2eEnvironment(process.env, frontendDir);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
}
const host = new URL(url).hostname;
if (!/^(localhost|127\.0\.0\.1)$/.test(host)) {
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL aponta para ${host}: esta fixture só é criada no Supabase local (ver E2E_ENV_PATH em .env.e2e.example)`,
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

// Hash real do campo (o que o save grava): o veredito vale pela versão da
// pergunta, e o banco carimba esse hash nas reviews e nos ciclos de
// auto-revisão.
const FIELDS = [
  { id: "e2e00000-0000-4000-8000-0000000007a1", name: "x", description: "Pergunta principal" },
  { id: "e2e00000-0000-4000-8000-0000000007a2", name: "other", description: "Outra pergunta" },
].map((f) => {
  const field = { ...f, type: "text" as const, options: null };
  return { ...field, hash: fieldHashOf(field) };
});
const ANSWER_FIELD_HASHES = Object.fromEntries(FIELDS.map((f) => [f.name, f.hash]));
// O mesmo carimbo de schema no projeto e nas respostas.
const SCHEMA_STAMP = {
  pydantic_hash: "e2e-llm-decisions-schema-hash",
  schema_version_major: 1,
  schema_version_minor: 0,
  schema_version_patch: 0,
};
const LLM_ANSWERS = { x: "Resposta LLM", other: "Outra LLM" };
const HUMAN_ANSWERS = { x: "Resposta humana", other: "Outra humana" };
const LLM_NAME = "LLM";
const HUMAN_NAME = "Pesquisador E2E";

async function profileId(email: string): Promise<string> {
  const { data, error } = await supabase.from("profiles").select("id").eq("email", email).single();
  if (error || !data) throw new Error(`profile ${email}: ${error?.message}`);
  return data.id as string;
}

async function ensureProject(mode: Mode, coordId: string): Promise<string> {
  const name = `LLM decision browser fixture ${mode}`;
  const { data: existing, error: findError } = await supabase
    .from("projects")
    .select("id, pydantic_fields")
    .eq("name", name)
    .maybeSingle();
  if (findError) throw new Error(`projects: ${findError.message}`);
  if (existing) {
    // O schema só é gravado na criação: o banco recusa avançar `schema_revision`
    // sem mudança de schema. Se alguém o mudou depois, recusar é melhor que
    // seguir com respostas carimbadas com hashes que o projeto não tem mais.
    if (!sameStoredFields(existing.pydantic_fields, FIELDS)) {
      throw new Error(`O schema do projeto "${name}" (${existing.id}) mudou. Apague o projeto e rode de novo.`);
    }
    const { error } = await supabase.from("projects").update({ automation_mode: mode }).eq("id", existing.id);
    if (error) throw new Error(`update projects: ${error.message}`);
    return existing.id as string;
  }
  const { data, error } = await supabase
    .from("projects")
    .insert({
      ...SCHEMA_STAMP,
      pydantic_fields: FIELDS,
      automation_mode: mode,
      name,
      description: "Fixture sintético do smoke de decisões do LLM Insights (#738). Pode ser apagado.",
      created_by: coordId,
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
      ...SCHEMA_STAMP,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert responses: ${error?.message}`);
  return data.id as string;
}

async function seed(mode: Mode, projectId: string, coordId: string, memberId: string): Promise<void> {
  const { error: membersError } = await supabase.from("project_members").upsert(
    [
      { project_id: projectId, user_id: coordId, role: "coordenador" },
      { project_id: projectId, user_id: memberId, role: "pesquisador" },
    ],
    { onConflict: "project_id,user_id" },
  );
  if (membersError) throw new Error(`upsert project_members: ${membersError.message}`);

  const documentId = await recreateDocument(projectId);
  const base = { project_id: projectId, document_id: documentId };
  const justification = "Justificativa sintética do LLM.";
  const llmId = await insertResponse({
    ...base,
    respondent_type: "llm",
    respondent_name: LLM_NAME,
    answers: LLM_ANSWERS,
    justifications: { x: justification, other: justification },
  });
  const humanId = await insertResponse({
    ...base,
    respondent_type: "humano",
    respondent_id: memberId,
    respondent_name: HUMAN_NAME,
    answers: HUMAN_ANSWERS,
  });

  if (mode === "compare_llm") {
    // O coordenador arbitrou as duas divergências na Comparação, a favor do
    // pesquisador. `response_snapshot` é o que o `submitVerdict` grava: as
    // respostas que o revisor viu, e sem elas a invariante
    // review-com-escolha-tem-snapshot-da-escolhida acusa a review.
    const { error } = await supabase.from("reviews").insert(
      FIELDS.map((f) => {
        const name = f.name as keyof typeof HUMAN_ANSWERS;
        return {
          ...base,
          field_name: name,
          reviewer_id: coordId,
          verdict: HUMAN_ANSWERS[name],
          chosen_response_id: humanId,
          response_snapshot: [
            { id: llmId, respondent_name: LLM_NAME, respondent_type: "llm", answer: LLM_ANSWERS[name], justification },
            { id: humanId, respondent_name: HUMAN_NAME, respondent_type: "humano", answer: HUMAN_ANSWERS[name] },
          ],
        };
      }),
    );
    if (error) throw new Error(`insert reviews: ${error.message}`);
  } else {
    // Auto-revisão, os dois ciclos já fechados (nenhum espera atribuição): em
    // `x` o pesquisador contestou o LLM e o coordenador arbitrou a favor dele;
    // em `other` o pesquisador marcou "ambíguo", que não vai ao gabarito. Os
    // snapshots das respostas o banco grava sozinho, na inserção.
    const now = new Date().toISOString();
    const cycle = { ...base, human_response_id: humanId, llm_response_id: llmId, self_reviewer_id: memberId, self_reviewed_at: now };
    const { error } = await supabase.from("field_reviews").insert([
      {
        ...cycle,
        field_name: "x",
        self_verdict: "contesta_llm",
        self_justification: "O documento diz outra coisa.",
        arbitrator_id: coordId,
        blind_verdict: "humano",
        blind_decided_at: now,
        final_verdict: "humano",
        final_decided_at: now,
      },
      { ...cycle, field_name: "other", self_verdict: "ambiguo" },
    ]);
    if (error) throw new Error(`insert field_reviews: ${error.message}`);
  }
  // A resposta do LLM enfileira a reconciliação da auto-revisão nos dois modos.
  // Enquanto a request existe, a view `final_answers` dá o documento como
  // "aguarda reconciliação" e o card não abre decisão. Os ciclos que o dreno
  // abriria já estão gravados acima (em compare_llm ele não abre nenhum), então
  // apagá-la é o estado pós-dreno.
  const { error: drainError } = await supabase
    .from("auto_review_reconciliation_requests")
    .delete()
    .eq("document_id", documentId);
  if (drainError) throw new Error(`delete auto_review_reconciliation_requests: ${drainError.message}`);
}

const [coordId, memberId] = await Promise.all([profileId(COORDINATOR_EMAIL), profileId(MEMBER_EMAIL)]);
const ids: string[] = [];
for (const mode of MODES) {
  const projectId = await ensureProject(mode, coordId);
  // O mesmo lock que o spec toma (e2e/fixture-lock.ts): recriar o documento no
  // meio do teste de outra worktree trocaria o documento debaixo dele.
  const lock = await acquireFixtureLock(projectId, {
    dir: defaultFixtureLockDir(process.env, frontendDir),
    label: "npm run e2e:fixture:llm-decisions",
    waitMs: fixtureLockWaitMs(process.env),
  });
  try {
    await seed(mode, projectId, coordId, memberId);
  } finally {
    lock.release();
  }
  console.log(`${mode}: ${projectId}`);
  ids.push(projectId);
}
console.log(`\nE2E_LLM_DECISIONS_PROJECT_IDS=${ids.join(",")}`);
