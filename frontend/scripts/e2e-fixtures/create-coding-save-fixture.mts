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
// Contra o Supabase local:  E2E_ENV_PATH=<arquivo> npm run e2e:fixture:coding
import { fixtureClient } from "./fixture-client";

// O mesmo ambiente que o playwright.config.ts carrega, inclusive o
// E2E_ENV_PATH: a fixture nasce no banco que o spec lê. Os e-mails vêm do
// ambiente, nunca hardcoded: a fixture vale para qualquer instância Clerk
// (dev de outro contribuidor, instância nova), não só para os usuários de
// teste desta máquina.
const {
  supabase,
  coordinatorEmail: COORDINATOR_EMAIL,
  memberEmail: MEMBER_EMAIL,
} = fixtureClient();

const PROJECT_NAME = "Codificação (save path) — teste E2E";

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
        // `id` fixo: a CHECK projects_pydantic_fields_shape exige id UUID
        // canônico em todo campo.
        {
          id: "e2e00000-0000-4000-8000-000000000001",
          hash: "666b31814034",
          name: "resumo",
          type: "text",
          options: null,
          description: "Resumo do documento",
        },
        {
          id: "e2e00000-0000-4000-8000-000000000002",
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

// 2. Documentos. O "Doc E2E save 2" é deliberado e não duplica a pergunta na
// tela (a "via 1" da #540, nunca reproduzida): só o doc 1 tem assignment, a
// fila do modo Atribuídos vem dos assignments do membro, e a view renderiza
// um documento por vez. A pergunta em dobro observada era a cópia órfã do
// segmento de Suspense, que `visivel()` filtra (#798, #806).
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
