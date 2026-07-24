// Cria o projeto E2E dedicado ao smoke do fluxo de SALVAMENTO de codificação
// (frontend/e2e/coding-save.smoke.spec.ts) e imprime o E2E_CODING_PROJECT_ID
// para colar no .env.e2e. Estrutura replicada do projeto de referência
// 1d8afb23 ("Comparação #430 — teste E2E"), com automation_mode 'none' (o
// smoke testa só o par responses×assignments, sem automação).
//
// Idempotente: reutiliza projeto, documentos, membros e assignment pelo nome/
// título, então rodar de novo é seguro e devolve sempre o mesmo id.
//
// Versionado (e não deixado no harness local) porque E2E_CODING_PROJECT_ID é
// obrigatória no gate de pre-push: sem a receita no repo, um clone novo trava
// no gate sem caminho para destravar.
//
// Rodar de frontend/:  npm run e2e:fixture:coding
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  applyEnvironment,
  readOptionalEnvironmentFile,
} from "../worktree-env/env-contract.mjs";

// Mesmo par de arquivos, na mesma ordem de precedência, que o
// playwright.config.ts carrega: as credenciais Supabase vêm de .env.local e os
// usuários de teste de .env.e2e, que sobrescreve. Ancorado no diretório do
// próprio script (não no cwd) pelo mesmo motivo documentado lá — rodar da raiz
// do repo acharia o contrato e nenhum valor.
const frontendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
applyEnvironment(process.env, readOptionalEnvironmentFile(join(frontendDir, ".env.local")));
applyEnvironment(process.env, readOptionalEnvironmentFile(join(frontendDir, ".env.e2e")), {
  override: true,
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
}
const supabase = createClient(url, key);

const PROJECT_NAME = "Codificação (save path) — teste E2E";

// Lidos do ambiente, nunca hardcoded: a fixture precisa valer para qualquer
// instância Clerk (dev de outro contribuidor, instância nova), não só para os
// usuários de teste desta máquina. São as mesmas variáveis que o Playwright já
// exige — ver .env.e2e.example.
const COORDINATOR_EMAIL = process.env.E2E_COORDINATOR_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
if (!COORDINATOR_EMAIL || !MEMBER_EMAIL) {
  throw new Error(
    "E2E_COORDINATOR_EMAIL / E2E_MEMBER_EMAIL ausentes — configure frontend/.env.e2e (ver .env.e2e.example)",
  );
}

async function profileIdByEmail(email: string): Promise<string> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();
  if (error || !data) throw new Error(`profile não encontrado para ${email}: ${error?.message}`);
  return data.id as string;
}

const coordinatorId = await profileIdByEmail(COORDINATOR_EMAIL);
const memberId = await profileIdByEmail(MEMBER_EMAIL);

// 1. Projeto (reutiliza pelo nome)
const { data: existingProject, error: findErr } = await supabase
  .from("projects")
  .select("id")
  .eq("name", PROJECT_NAME)
  .maybeSingle();
if (findErr) throw findErr;

let projectId: string;
if (existingProject) {
  projectId = existingProject.id as string;
  console.log(`Projeto já existe, reutilizando: ${projectId}`);
} else {
  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      name: PROJECT_NAME,
      description:
        "Projeto sintético para o smoke E2E do salvamento de codificação (responses×assignments). Pode ser apagado.",
      created_by: coordinatorId,
      automation_mode: "none",
      pydantic_hash: "e2e-coding-save-schema-hash",
      pydantic_fields: [
        // Hashes REAIS (computeFieldHash) e não placeholders: o save do app
        // propaga field.hash para responses.answer_field_hashes, e um
        // placeholder violaria a invariante de shape do checker
        // ('answer-field-hashes-do-universo-do-projeto').
        {
          hash: "666b31814034",
          name: "resumo",
          type: "text",
          options: null,
          description: "Resumo do documento",
        },
        {
          hash: "0feea7dd6b3d",
          name: "observacao",
          type: "text",
          options: null,
          description: "Observação livre",
        },
      ],
      schema_version_major: 1,
      schema_version_minor: 0,
      schema_version_patch: 0,
    })
    .select("id")
    .single();
  if (error || !project) throw new Error(`insert projects falhou: ${error?.message}`);
  projectId = project.id as string;
  console.log(`Projeto criado: ${projectId}`);
}

// 2. Documentos
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n\n" +
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\n\n" +
  "Curabitur pretium tincidunt lacus, at facilisis mi porta vitae. Nulla facilisi. Integer lacinia sollicitudin massa, non tristique sapien dictum quis. Cras ornare arcu sed viverra placerat.";

const docIds: string[] = [];
for (const n of [1, 2]) {
  const title = `Doc E2E save ${n}`;
  const { data: existingDoc } = await supabase
    .from("documents")
    .select("id")
    .eq("project_id", projectId)
    .eq("title", title)
    .maybeSingle();
  if (existingDoc) {
    docIds.push(existingDoc.id as string);
    continue;
  }
  const { data: doc, error } = await supabase
    .from("documents")
    .insert({
      project_id: projectId,
      external_id: `E2E-CODING-SAVE-${n}`,
      title,
      text: LOREM,
    })
    .select("id")
    .single();
  if (error || !doc) throw new Error(`insert documents ${n} falhou: ${error?.message}`);
  docIds.push(doc.id as string);
}
console.log(`Documentos: ${docIds.join(", ")}`);

// 3. Membros
for (const [userId, role] of [
  [coordinatorId, "coordenador"],
  [memberId, "pesquisador"],
] as const) {
  const { data: existing } = await supabase
    .from("project_members")
    .select("id")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) continue;
  const { error } = await supabase
    .from("project_members")
    .insert({ project_id: projectId, user_id: userId, role });
  if (error) throw new Error(`insert project_members (${role}) falhou: ${error.message}`);
}
console.log("Membros ok (coordenador + pesquisador)");

// 4. Assignment de codificação do doc 1 para o membro
const { data: existingAssign } = await supabase
  .from("assignments")
  .select("id")
  .eq("project_id", projectId)
  .eq("document_id", docIds[0])
  .eq("user_id", memberId)
  .eq("type", "codificacao")
  .maybeSingle();
if (!existingAssign) {
  const { error } = await supabase.from("assignments").insert({
    project_id: projectId,
    document_id: docIds[0],
    user_id: memberId,
    type: "codificacao",
    status: "pendente",
  });
  if (error) throw new Error(`insert assignments falhou: ${error.message}`);
}
console.log("Assignment de codificação ok");

console.log(`\nE2E_CODING_PROJECT_ID=${projectId}`);
