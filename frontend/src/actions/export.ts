"use server";

// Server action do export completo (feature 004). Só exports async vivem aqui —
// export síncrono em módulo "use server" quebra o deploy silenciosamente e nenhum
// gate local pega (lição do PR #412); a montagem pura mora em lib/export/assemble.
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import type { PydanticField } from "@/lib/types";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import type { ErrorResolutionRow } from "@/lib/error-resolution";
import type { EquivalenceRow } from "@/lib/compare-divergence";
import { usesAutoReviewSource } from "@/lib/llm-error-metrics";
import {
  assembleExport,
  type ExportDataset,
  type ExportDocument,
  type ExportFinalAnswer,
  type ExportResponse,
  type ExportReview,
} from "@/lib/export/assemble";

export type GetExportDatasetResult = ExportDataset | { error: string };

export interface ExportOptions {
  /** Ver `AssembleInput.fillFromLlm`. */
  fillFromLlm?: boolean;
}

// Retorna o conjunto completo do projeto (documentos + respostas + gabarito)
// já montado como planilhas de strings. Gate coordinator-only (fail-closed);
// lê documents.metadata APENAS aqui, nunca na listagem da página. As queries
// são paralelas e usam colunas explícitas (Princípio II de velocidade), exceto
// `final_answers`, que depende do modo de automação lido no projeto.
export async function getExportDataset(
  projectId: string,
  options: ExportOptions = {},
): Promise<GetExportDatasetResult> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem exportar os dados do projeto."
  );
  if (!gate.ok) return { error: gate.error };

  const supabase = await createSupabaseServer();

  const [
    { data: project, error: projectError },
    { data: documents, error: documentsError },
    { data: responses, error: responsesError },
    { data: reviews, error: reviewsError },
    { data: errorResolutions, error: resolutionsError },
    { data: equivalences, error: equivalencesError },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("name, pydantic_fields, min_responses_for_comparison, automation_mode")
      .eq("id", projectId)
      .single(),
    // Base exportada: documentos não excluídos. Exclusão apenas pendente
    // (exclusion_pending_at) continua na base até ser confirmada. Paginado para
    // não truncar em projetos grandes (ver fetchAllPaged).
    fetchAllPaged<ExportDocument>(() =>
      supabase
        .from("documents")
        .select("id, external_id, title, created_at, metadata")
        .eq("project_id", projectId)
        .is("excluded_at", null),
      ["id"],
    ),
    fetchAllPaged<ExportResponse>(() =>
      supabase
        .from("responses")
        .select("id, document_id, respondent_name, respondent_type, answers, answer_field_hashes")
        .eq("project_id", projectId)
        .eq("is_latest", true),
      ["id"],
    ),
    fetchAllPaged<ExportReview>(() =>
      supabase
        .from("reviews")
        .select("id, document_id, field_name, verdict, comment, created_at, field_hash, chosen_response_id")
        .eq("project_id", projectId),
      ["id"],
    ),
    fetchAllPaged<ErrorResolutionRow>(() => supabase.rpc("read_error_resolutions", { p_project_id: projectId }), ["id"]),
    // As colunas de snapshot são obrigatórias: `filterCurrentEquivalencePairs`
    // é fail-closed e descarta todo par que venha sem elas.
    fetchAllPaged<EquivalenceRow>(() =>
      supabase
        .from("response_equivalences")
        .select("id, document_id, field_name, response_a_id, response_b_id, reviewer_id, response_a_answer_snapshot, response_b_answer_snapshot")
        .eq("project_id", projectId)
        .is("superseded_at", null),
      ["id"],
    ),
  ]);

  const error = [
    projectError,
    documentsError,
    responsesError,
    reviewsError,
    resolutionsError,
    equivalencesError,
  ].find(Boolean);
  if (error) return { error: error.message };
  if (!project) return { error: "Projeto não encontrado." };

  // Fora de 'auto_review_llm', `field_reviews` não é materializado e a view
  // devolveria 'consenso' para todo campo, o que aqui não decide nada.
  // `final_answers` é view sem PK: (documento, campo) é a ordem total, pela
  // invariante de uma única resposta LLM `is_latest` por documento.
  const finalAnswers = usesAutoReviewSource(project.automation_mode)
    ? await fetchAllPaged<ExportFinalAnswer>(() =>
        supabase
          .from("final_answers")
          .select("document_id, field_name, provenance, answer")
          .eq("project_id", projectId),
        ["document_id", "field_name"],
      )
    : { data: [], error: null };
  if (finalAnswers.error) return { error: finalAnswers.error.message };

  // documents/responses/reviews já são arrays (fetchAllPaged nunca devolve null).
  return assembleExport({
    projectName: project.name || "Projeto",
    fields: (project.pydantic_fields || []) as PydanticField[],
    minResponses: project.min_responses_for_comparison || 2,
    documents,
    responses,
    reviews,
    errorResolutions,
    equivalences,
    finalAnswers: finalAnswers.data,
    // O argumento chega do cliente: só o `true` literal liga a opção.
    fillFromLlm: options.fillFromLlm === true,
  });
}
