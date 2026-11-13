"use server";

// Server action da planilha dos vereditos da auto-revisão. Só exports async
// vivem aqui (export síncrono em módulo "use server" quebra o deploy, lição do
// PR #412); a montagem e os filtros moram em lib/export/auto-review-verdicts.
//
// Gate coordinator-only (fail-closed). A leitura usa o cliente autenticado: a
// policy "Members view own field_reviews" já dá ao coordenador todos os ciclos
// do projeto, então não há service key aqui.
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import type { PydanticField } from "@/lib/types";
import {
  reviewerDisplayName,
  type AutoReviewVerdictData,
  type AutoReviewVerdictDocument,
  type AutoReviewVerdictRow,
} from "@/lib/export/auto-review-verdicts";

export type GetAutoReviewVerdictsResult = AutoReviewVerdictData | { error: string };

export interface AutoReviewVerdictsOptions {
  /** Traz também os ciclos arquivados (`superseded_at` preenchido). */
  includeArchived?: boolean;
}

// Lê os ciclos com veredito do pesquisador (todos os vereditos: o filtro por
// veredito e por pesquisador é do card, sem nova ida ao banco). Três leituras
// paralelas com colunas explícitas e paginadas; os nomes dos pesquisadores vêm
// depois, só dos ids que aparecem nos ciclos.
export async function getAutoReviewVerdicts(
  projectId: string,
  options: AutoReviewVerdictsOptions = {},
): Promise<GetAutoReviewVerdictsResult> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem exportar os vereditos da auto-revisão.",
  );
  if (!gate.ok) return { error: gate.error };

  // O argumento chega do cliente: só o `true` literal liga a opção.
  const includeArchived = options.includeArchived === true;
  const supabase = await createSupabaseServer();

  const [
    { data: project, error: projectError },
    { data: documents, error: documentsError },
    { data: reviews, error: reviewsError },
  ] = await Promise.all([
    supabase.from("projects").select("name, pydantic_fields").eq("id", projectId).single(),
    // Base: documentos não excluídos, como no export geral e no script.
    fetchAllPaged<AutoReviewVerdictDocument>(
      () =>
        supabase
          .from("documents")
          .select("id, external_id, title")
          .eq("project_id", projectId)
          .is("excluded_at", null),
      ["id"],
    ),
    fetchAllPaged<AutoReviewVerdictRow>(() => {
      const query = supabase
        .from("field_reviews")
        .select(
          "id, document_id, field_name, self_verdict, self_justification, self_reviewer_id, human_answer_snapshot, llm_answer_snapshot, llm_justification_snapshot, final_verdict, arbitrator_comment, field_hash, cycle_no, superseded_at, superseded_reason",
        )
        .eq("project_id", projectId)
        .not("self_verdict", "is", null);
      return includeArchived ? query : query.is("superseded_at", null);
    }, ["id"]),
  ]);

  const error = [projectError, documentsError, reviewsError].find(Boolean);
  if (error) return { error: error.message };
  if (!project) return { error: "Projeto não encontrado." };

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
    documents,
    reviews,
    reviewers,
    includeArchived,
  };
}
