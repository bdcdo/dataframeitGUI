import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { isCodingComplete } from "@/lib/coding-completeness";
import type { EquivalencePair } from "@/lib/equivalence";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

type Admin = ReturnType<typeof createSupabaseAdmin>;

// Modos de automação que materializam uma comparação (assignment type=comparacao)
// para um revisor terceiro. auto_review_llm e none não passam por aqui.
export type ComparisonMode = "compare_humans" | "compare_llm";

// Log estruturado JSON com prefixo "[auto-compare]" — pesquisavel em logs
// Vercel/Fly via `grep '[auto-compare]'`. Espelha o logger de lib/auto-review.ts.
function log(
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  const payload = JSON.stringify({ event, ...fields });
  const line = `[auto-compare] ${payload}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

interface ResponseRow {
  id: string;
  respondent_id?: string | null;
  answers: Record<string, unknown> | null;
  answer_field_hashes: AnswerFieldHashes | null;
}

function toResponseLike(r: ResponseRow) {
  return {
    id: r.id,
    answers: (r.answers as Record<string, unknown>) ?? {},
    answerFieldHashes: r.answer_field_hashes as AnswerFieldHashes,
  };
}

function buildEquivByField(
  rows: Array<{ field_name: string; response_a_id: string; response_b_id: string }> | null,
): Map<string, EquivalencePair[]> {
  const map = new Map<string, EquivalencePair[]>();
  for (const eq of rows ?? []) {
    const list = map.get(eq.field_name) ?? [];
    list.push({ response_a_id: eq.response_a_id, response_b_id: eq.response_b_id });
    map.set(eq.field_name, list);
  }
  return map;
}

// Sorteia UM revisor de comparação para o documento e cria o assignment
// (type=comparacao) idempotente. Espelha assignArbitrator (actions/field-reviews.ts):
//   - Pool = membros can_compare=true MENOS todos os codificadores (coderIds) —
//     sem fallback: um codificador comparando o próprio doc julgaria a própria
//     codificação. Pool vazio → noPool=true (banner de pendência ao coordenador).
//   - Balanceia por menor carga de comparações abertas; desempate aleatório.
//   - precomputedOpenLoad: quando passado (batch do retry), evita N queries de
//     carga e é incrementado a cada atribuição para balancear entre docs.
export async function assignComparisonReviewer(
  admin: Admin,
  projectId: string,
  documentId: string,
  coderIds: Set<string>,
  precomputedOpenLoad?: Map<string, number>,
): Promise<{ assigned: boolean; noPool: boolean }> {
  const { data: eligibleMembers } = await admin
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("can_compare", true);

  const eligible = (eligibleMembers ?? []).filter(
    (m) => !coderIds.has(m.user_id as string),
  );
  if (eligible.length === 0) return { assigned: false, noPool: true };

  let loadByUser: Map<string, number>;
  if (precomputedOpenLoad) {
    loadByUser = precomputedOpenLoad;
  } else {
    const { data: openCounts } = await admin
      .from("assignments")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("type", "comparacao")
      .neq("status", "concluido");
    loadByUser = new Map<string, number>();
    for (const r of openCounts ?? []) {
      loadByUser.set(r.user_id, (loadByUser.get(r.user_id) ?? 0) + 1);
    }
  }

  let minLoad = Infinity;
  for (const m of eligible) {
    const l = loadByUser.get(m.user_id) ?? 0;
    if (l < minLoad) minLoad = l;
  }
  const candidatesAtMin = eligible.filter(
    (m) => (loadByUser.get(m.user_id) ?? 0) === minLoad,
  );

  // Desempate aleatorio entre os de menor carga (sem preferencia de role).
  const reviewerId = candidatesAtMin[
    Math.floor(Math.random() * candidatesAtMin.length)
  ].user_id as string;

  const { error } = await admin.from("assignments").upsert(
    {
      project_id: projectId,
      document_id: documentId,
      user_id: reviewerId,
      type: "comparacao",
      status: "pendente",
    },
    { onConflict: "document_id,user_id,type", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);

  // Mantem a carga in-memory coerente para o proximo doc do batch (retry).
  if (precomputedOpenLoad) {
    precomputedOpenLoad.set(reviewerId, (precomputedOpenLoad.get(reviewerId) ?? 0) + 1);
  }

  return { assigned: true, noPool: false };
}

// Detecta divergencia segundo o modo e, se houver, materializa um assignment
// comparacao para um revisor terceiro. Chamado de saveResponse() apos a
// codificacao virar "concluido". Usa admin client porque a policy de assignments
// restringe INSERT a coordenadores; aqui o pesquisador precisa criar a fila.
//
// "o minimo necessario para liberar a revisao":
//   compare_humans → >= min_responses_for_comparison humanos completos
//   compare_llm    → >= 1 humano completo + resposta LLM
// comparison_includes_llm (so compare_humans) decide se o LLM entra no calculo
// de divergencia que dispara.
export async function createAutoComparisonIfDiverges(
  projectId: string,
  documentId: string,
  mode: ComparisonMode,
): Promise<{ assigned: boolean; noPool: boolean }> {
  const admin = createSupabaseAdmin();

  const [
    { data: project },
    { data: humanResponses },
    { data: llmResponse },
    { data: equivalences },
    { data: activeAssignments },
  ] = await Promise.all([
    admin
      .from("projects")
      .select("pydantic_fields, min_responses_for_comparison, comparison_includes_llm")
      .eq("id", projectId)
      .single(),
    admin
      .from("responses")
      .select("id, respondent_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "humano")
      .eq("is_latest", true),
    admin
      .from("responses")
      .select("id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "llm")
      .eq("is_latest", true)
      .maybeSingle(),
    admin
      .from("response_equivalences")
      .select("field_name, response_a_id, response_b_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId),
    admin
      .from("assignments")
      .select("id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("type", "comparacao")
      .neq("status", "concluido")
      .limit(1),
  ]);

  if (!project?.pydantic_fields) {
    log("skip_no_data", { projectId, documentId, mode }, "warn");
    return { assigned: false, noPool: false };
  }
  const fields = project.pydantic_fields as PydanticField[];

  // Idempotencia: ja existe comparacao ativa para este doc → nao re-sorteia.
  if (activeAssignments && activeAssignments.length > 0) {
    log("skip_active_assignment", { projectId, documentId, mode });
    return { assigned: false, noPool: false };
  }

  // So codificacoes humanas completas contam para o gatilho (#174).
  // NOTA (#247, follow-up): este gatilho conta toda resposta `is_latest`, sem
  // aplicar o piso de versao do default vivo (COMPARE_DEFAULT_VERSION =
  // "latest_major"). A fila (compare/page.tsx) e o fecho (compare-sync.ts) ja
  // usam esse piso; aqui ainda nao. Efeito: uma divergencia que so existe entre
  // majors antigos pode materializar um assignment que a fila nao mostra e que o
  // fecho (latest_major) considera concluivel de imediato — fantasma cosmetico,
  // nao a trava do #217. Alinhar exige buscar schema_version/pydantic_hash e
  // aplicar responseQualifiesForVersion aqui; deixado como follow-up.
  const completeHumans = (humanResponses ?? []).filter((r) =>
    isCodingComplete(fields, (r.answers as Record<string, unknown>) ?? {}),
  );

  const minHumans =
    mode === "compare_humans" ? (project.min_responses_for_comparison ?? 2) : 1;
  if (completeHumans.length < minHumans) {
    log("skip_insufficient", {
      projectId,
      documentId,
      mode,
      completeHumans: completeHumans.length,
      minHumans,
    });
    return { assigned: false, noPool: false };
  }
  if (mode === "compare_llm" && !llmResponse) {
    log("skip_insufficient", { projectId, documentId, mode, reason: "no_llm" });
    return { assigned: false, noPool: false };
  }

  const includeLlm =
    mode === "compare_llm" ||
    (mode === "compare_humans" && project.comparison_includes_llm === true);

  const responsesForDivergence = completeHumans.map((r) =>
    toResponseLike(r as ResponseRow),
  );
  if (includeLlm && llmResponse) {
    responsesForDivergence.push(toResponseLike(llmResponse as ResponseRow));
  }
  if (responsesForDivergence.length < 2) {
    log("skip_insufficient", {
      projectId,
      documentId,
      mode,
      reason: "needs_two_responses",
    });
    return { assigned: false, noPool: false };
  }

  const divergent = computeDivergentFieldNames(
    fields,
    responsesForDivergence,
    buildEquivByField(equivalences),
  );
  if (divergent.length === 0) {
    log("consensus", { projectId, documentId, mode, totalFields: fields.length });
    return { assigned: false, noPool: false };
  }

  const coderIds = new Set<string>();
  for (const r of completeHumans) {
    if (r.respondent_id) coderIds.add(r.respondent_id as string);
  }

  const result = await assignComparisonReviewer(admin, projectId, documentId, coderIds);
  log(result.assigned ? "created" : "no_pool", {
    projectId,
    documentId,
    mode,
    divergentCount: divergent.length,
    divergentFields: divergent,
  });
  return result;
}

// Varre o projeto e devolve os documentos que DIVERGEM (segundo o modo) e ainda
// nao tem comparacao ativa — o "backlog" sem revisor. Usado pelo retry
// (atribui) e pelo banner de pendencia (conta). Varredura em 2 fases para nao
// puxar `answers` de todo doc: fase 1 acha candidatos por metadado leve, fase 2
// busca answers so deles e recomputa divergencia.
export async function scanComparisonBacklog(
  admin: Admin,
  projectId: string,
  mode: ComparisonMode,
): Promise<Array<{ documentId: string; coderIds: Set<string> }>> {
  // Fase 1: metadados leves (sem answers).
  const [{ data: project }, { data: humanMeta }, { data: activeAsg }] =
    await Promise.all([
      admin
        .from("projects")
        .select("pydantic_fields, min_responses_for_comparison, comparison_includes_llm")
        .eq("id", projectId)
        .single(),
      admin
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .eq("respondent_type", "humano")
        .eq("is_latest", true),
      admin
        .from("assignments")
        .select("document_id")
        .eq("project_id", projectId)
        .eq("type", "comparacao")
        .neq("status", "concluido"),
    ]);

  if (!project?.pydantic_fields) return [];
  const fields = project.pydantic_fields as PydanticField[];
  if (fields.length === 0) return [];

  const docsWithActive = new Set(
    (activeAsg ?? []).map((a) => a.document_id as string),
  );

  const humansByDoc = new Map<string, Set<string>>();
  for (const r of humanMeta ?? []) {
    const docId = r.document_id as string;
    const respId = r.respondent_id as string | null;
    if (!respId) continue;
    const set = humansByDoc.get(docId) ?? new Set<string>();
    set.add(respId);
    humansByDoc.set(docId, set);
  }

  const minHumans =
    mode === "compare_humans" ? (project.min_responses_for_comparison ?? 2) : 1;

  // Candidatos: humanos suficientes (por respondente; completude conferida na
  // fase 2) e sem comparacao ativa.
  const candidates = [...humansByDoc.entries()]
    .filter(([docId, humans]) => humans.size >= minHumans && !docsWithActive.has(docId))
    .map(([docId]) => docId);
  if (candidates.length === 0) return [];

  // Fase 2: answers só dos candidatos.
  const [{ data: humanFull }, { data: llmFull }, { data: equivs }] =
    await Promise.all([
      admin
        .from("responses")
        .select("id, document_id, respondent_id, answers, answer_field_hashes")
        .eq("project_id", projectId)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .in("document_id", candidates),
      admin
        .from("responses")
        .select("id, document_id, answers, answer_field_hashes")
        .eq("project_id", projectId)
        .eq("respondent_type", "llm")
        .eq("is_latest", true)
        .in("document_id", candidates),
      admin
        .from("response_equivalences")
        .select("document_id, field_name, response_a_id, response_b_id")
        .eq("project_id", projectId)
        .in("document_id", candidates),
    ]);

  const llmByDoc = new Map(
    (llmFull ?? []).map((r) => [r.document_id as string, r as ResponseRow & { document_id: string }]),
  );

  const humansFullByDoc = new Map<string, Array<ResponseRow & { document_id: string }>>();
  for (const r of humanFull ?? []) {
    const docId = r.document_id as string;
    const list = humansFullByDoc.get(docId) ?? [];
    list.push(r as ResponseRow & { document_id: string });
    humansFullByDoc.set(docId, list);
  }

  const equivByDoc = new Map<string, Map<string, EquivalencePair[]>>();
  for (const eq of equivs ?? []) {
    const docId = eq.document_id as string;
    const byField = equivByDoc.get(docId) ?? new Map<string, EquivalencePair[]>();
    const list = byField.get(eq.field_name) ?? [];
    list.push({ response_a_id: eq.response_a_id, response_b_id: eq.response_b_id });
    byField.set(eq.field_name, list);
    equivByDoc.set(docId, byField);
  }

  const result: Array<{ documentId: string; coderIds: Set<string> }> = [];
  for (const docId of candidates) {
    const completeHumans = (humansFullByDoc.get(docId) ?? []).filter((r) =>
      isCodingComplete(fields, (r.answers as Record<string, unknown>) ?? {}),
    );
    if (completeHumans.length < minHumans) continue;
    const llm = llmByDoc.get(docId);
    if (mode === "compare_llm" && !llm) continue;

    const includeLlm =
      mode === "compare_llm" ||
      (mode === "compare_humans" && project.comparison_includes_llm === true);

    const responses = completeHumans.map((r) => toResponseLike(r));
    if (includeLlm && llm) responses.push(toResponseLike(llm));
    if (responses.length < 2) continue;

    const divergent = computeDivergentFieldNames(
      fields,
      responses,
      equivByDoc.get(docId),
    );
    if (divergent.length === 0) continue;

    const coderIds = new Set<string>();
    for (const r of completeHumans) {
      if (r.respondent_id) coderIds.add(r.respondent_id as string);
    }
    result.push({ documentId: docId, coderIds });
  }

  return result;
}

// Solta as comparações PENDENTES atribuídas a `userId` (em_andamento/concluido
// ficam intactas). Disparada por setCanCompare ao desmarcar can_compare, antes
// do retry re-sortear. Espelha releaseArbitrationsFromUser, porém mais simples
// (não há field_reviews para limpar — a comparação é só o assignment).
export async function releaseComparisonsFromUser(
  admin: Admin,
  projectId: string,
  userId: string,
): Promise<{ released: number; error?: string }> {
  const { data: deleted, error } = await admin
    .from("assignments")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .eq("status", "pendente")
    .select("id");
  if (error) return { released: 0, error: error.message };
  return { released: deleted?.length ?? 0 };
}
