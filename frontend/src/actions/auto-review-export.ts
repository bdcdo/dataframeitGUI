"use server";

// Server action da planilha dos vereditos da auto-revisão. Só exports async
// vivem aqui (export síncrono em módulo "use server" quebra o deploy, lição do
// PR #412); a montagem e os filtros moram em lib/export/auto-review-verdicts.
//
// Gate coordinator-only (fail-closed). A leitura usa o cliente autenticado: as
// policies de SELECT de `field_reviews` e de
// `field_review_cycle_history_entries` já dão ao coordenador todos os ciclos
// do projeto, então não há service key aqui.
import { createSupabaseServer, type SupabaseServerClient } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import type { PydanticField } from "@/lib/types";
import {
  reviewerDisplayName,
  type AutoReviewVerdictData,
  type AutoReviewVerdictDocument,
  type AutoReviewVerdictRow,
} from "@/lib/export/auto-review-verdicts";

// As duas tabelas têm as mesmas colunas: o histórico nasce `AS TABLE
// field_reviews` (20260717120000). O documento vem embutido, com `!inner` e o
// filtro de exclusão: só os documentos com ciclo, e nenhum excluído, sem
// paginar a base inteira.
const CYCLE_COLUMNS =
  "id, document_id, field_name, self_verdict, self_justification, self_reviewer_id, human_answer_snapshot, llm_answer_snapshot, llm_justification_snapshot, final_verdict, arbitrator_comment, field_hash, cycle_no, superseded_at, superseded_reason, documents!inner(external_id, title)";

type EmbeddedDocument = Pick<AutoReviewVerdictDocument, "external_id" | "title">;

// Sem os tipos gerados do banco, o client infere o embed como lista; o
// PostgREST devolve objeto na relação muitos-para-um. Aceita os dois.
type CycleWithDocument = AutoReviewVerdictRow & {
  documents: EmbeddedDocument | EmbeddedDocument[];
};

function embeddedDocument(embed: CycleWithDocument["documents"]): EmbeddedDocument {
  return Array.isArray(embed) ? embed[0] : embed;
}

function fetchCycles(
  supabase: SupabaseServerClient,
  table: "field_reviews" | "field_review_cycle_history_entries",
  projectId: string,
  currentOnly: boolean,
) {
  return fetchAllPaged<CycleWithDocument>(() => {
    const query = supabase
      .from(table)
      .select(CYCLE_COLUMNS)
      .eq("project_id", projectId)
      .not("self_verdict", "is", null)
      .is("documents.excluded_at", null);
    return currentOnly ? query.is("superseded_at", null) : query;
  }, ["id"]);
}

const NO_CYCLES = { data: [] as CycleWithDocument[], error: null };

// Lê os ciclos com veredito do pesquisador (todos os vereditos: o filtro por
// veredito e por pesquisador é do card, sem nova ida ao banco). Sem a opção,
// só os ciclos vigentes de `field_reviews`; com ela, também os arquivados,
// que o banco move para o histórico. Os nomes dos pesquisadores vêm depois,
// só dos ids que aparecem nos ciclos.
export async function getAutoReviewVerdicts(
  projectId: string,
  /** `includeArchived`: traz também os ciclos que não valem mais (o histórico). */
  options: { includeArchived?: boolean } = {},
): Promise<AutoReviewVerdictData | { error: string }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem exportar os vereditos da auto-revisão.",
  );
  if (!gate.ok) return { error: gate.error };

  // O argumento chega do cliente: só o `true` literal liga a opção.
  const includeArchived = options.includeArchived === true;
  const supabase = await createSupabaseServer();

  const [{ data: project, error: projectError }, current, history] = await Promise.all([
    supabase.from("projects").select("name, pydantic_fields").eq("id", projectId).single(),
    fetchCycles(supabase, "field_reviews", projectId, !includeArchived),
    includeArchived
      ? fetchCycles(supabase, "field_review_cycle_history_entries", projectId, false)
      : NO_CYCLES,
  ]);

  const error = [projectError, current.error, history.error].find(Boolean);
  if (error) return { error: error.message };
  if (!project) return { error: "Projeto não encontrado." };

  // O arquivamento copia a linha para o histórico com o mesmo id; a de
  // `field_reviews` é a mais recente e vence.
  const byId = new Map<string, CycleWithDocument>();
  for (const cycle of [...history.data, ...current.data]) byId.set(cycle.id, cycle);
  const documents = new Map<string, AutoReviewVerdictDocument>();
  const reviews = [...byId.values()].map(({ documents: doc, ...review }) => {
    documents.set(review.document_id, { id: review.document_id, ...embeddedDocument(doc) });
    return review;
  });

  const reviewerIds = [...new Set(reviews.map((review) => review.self_reviewer_id))];
  const { data: profiles, error: profilesError } =
    reviewerIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, first_name, last_name, email")
          .in("id", reviewerIds)
      : { data: [], error: null };
  if (profilesError) return { error: profilesError.message };

  const nameById = new Map(
    (profiles ?? []).map((profile) => [profile.id, reviewerDisplayName(profile)]),
  );
  // Perfil ilegível (RLS) não tira o pesquisador da lista: fica o id.
  const reviewers = reviewerIds
    .map((id) => ({ id, name: nameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return {
    projectName: project.name || "Projeto",
    fields: (project.pydantic_fields || []) as PydanticField[],
    documents: [...documents.values()],
    reviews,
    reviewers,
  };
}
