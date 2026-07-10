"use server";

// Server action do export completo (feature 004). Só exports async vivem aqui —
// export síncrono em módulo "use server" quebra o deploy silenciosamente e nenhum
// gate local pega (lição do PR #412); a montagem pura mora em lib/export/assemble.
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import type { PydanticField } from "@/lib/types";
import {
  assembleExport,
  type ExportDataset,
  type ExportDocument,
  type ExportResponse,
  type ExportReview,
} from "@/lib/export/assemble";

export type GetExportDatasetResult = ExportDataset | { error: string };

// O PostgREST limita cada query a `max_rows` (1000 por padrão, hospedado e local).
// Sem paginar, um projeto grande teria a exportação truncada SILENCIOSAMENTE —
// contradizendo a FR-008 ("conjunto completo"). Buscamos por páginas com .range()
// até uma página vir incompleta. `build()` recria a query a cada página porque um
// builder do PostgREST é de uso único (o await o executa).
const EXPORT_PAGE_SIZE = 1000;

async function fetchAllPaged<T>(
  build: () => {
    range: (
      from: number,
      to: number
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  }
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    // await sequencial é da natureza da paginação: só dá para pedir a próxima
    // página sabendo que a anterior veio cheia.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await build().range(from, from + EXPORT_PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < EXPORT_PAGE_SIZE) break;
    from += EXPORT_PAGE_SIZE;
  }
  return { data: all, error: null };
}

// Retorna o conjunto completo do projeto (documentos + respostas + gabarito)
// já montado como planilhas de strings. Gate coordinator-only (fail-closed);
// lê documents.metadata APENAS aqui — nunca na listagem da página. As 4 queries
// são paralelas e usam colunas explícitas (Princípio II de velocidade).
export async function getExportDataset(
  projectId: string
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
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("name, pydantic_fields, min_responses_for_comparison")
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
        .is("excluded_at", null)
    ),
    fetchAllPaged<ExportResponse>(() =>
      supabase
        .from("responses")
        .select("document_id, respondent_name, respondent_type, answers")
        .eq("project_id", projectId)
        .eq("is_latest", true)
    ),
    fetchAllPaged<ExportReview>(() =>
      supabase
        .from("reviews")
        .select("document_id, field_name, verdict, comment")
        .eq("project_id", projectId)
    ),
  ]);

  const error = [
    projectError,
    documentsError,
    responsesError,
    reviewsError,
  ].find(Boolean);
  if (error) return { error: error.message };
  if (!project) return { error: "Projeto não encontrado." };

  // documents/responses/reviews já são arrays (fetchAllPaged nunca devolve null).
  return assembleExport({
    projectName: project.name || "Projeto",
    fields: (project.pydantic_fields || []) as PydanticField[],
    minResponses: project.min_responses_for_comparison || 2,
    documents,
    responses,
    reviews,
  });
}
