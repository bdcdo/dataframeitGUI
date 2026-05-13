import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import type { PydanticField } from "@/lib/types";

// Detecta divergencia humano vs LLM e materializa:
//   - 1 assignment auto_revisao para o humano (idempotente em doc+user+type)
//   - N rows pending em field_reviews (1 por campo divergente, idempotente em doc+field)
//
// Chamado de saveResponse() apos promocao para "concluido". Usa admin client
// porque a policy de assignments restringe INSERT a coordenadores; aqui o
// pesquisador precisa criar a propria fila de revisao.
export async function createAutoReviewIfDiverges(
  projectId: string,
  documentId: string,
  humanUserId: string,
): Promise<{ divergentCount: number }> {
  const admin = createSupabaseAdmin();

  const [{ data: project }, { data: humanResponse }, { data: llmResponse }] =
    await Promise.all([
      admin
        .from("projects")
        .select("pydantic_fields")
        .eq("id", projectId)
        .single(),
      admin
        .from("responses")
        .select("id, answers")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("respondent_id", humanUserId)
        .eq("respondent_type", "humano")
        .maybeSingle(),
      admin
        .from("responses")
        .select("id, answers")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("respondent_type", "llm")
        .eq("is_current", true)
        .maybeSingle(),
    ]);

  if (!project?.pydantic_fields || !humanResponse || !llmResponse) {
    return { divergentCount: 0 };
  }

  const fields = project.pydantic_fields as PydanticField[];
  const divergent = computeDivergentFieldNames(fields, [
    { id: humanResponse.id, answers: humanResponse.answers ?? {} },
    { id: llmResponse.id, answers: llmResponse.answers ?? {} },
  ]);

  if (divergent.length === 0) {
    return { divergentCount: 0 };
  }

  // Upsert assignment auto_revisao para o humano (idempotente via UNIQUE doc+user+type)
  await admin.from("assignments").upsert(
    {
      project_id: projectId,
      document_id: documentId,
      user_id: humanUserId,
      type: "auto_revisao",
      status: "pendente",
    },
    { onConflict: "document_id,user_id,type", ignoreDuplicates: true },
  );

  // Upsert field_reviews stubs (1 por campo divergente)
  const rows = divergent.map((fieldName) => ({
    project_id: projectId,
    document_id: documentId,
    field_name: fieldName,
    human_response_id: humanResponse.id,
    llm_response_id: llmResponse.id,
    self_reviewer_id: humanUserId,
  }));

  await admin.from("field_reviews").upsert(rows, {
    onConflict: "document_id,field_name",
    ignoreDuplicates: true,
  });

  return { divergentCount: divergent.length };
}
