import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import type { EquivalencePair } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";

// Log estruturado JSON com prefixo "[auto-review]" — pesquisavel em logs
// Vercel/Fly via `grep '[auto-review]'`. Campos minimos: event, projectId,
// documentId, userId (sempre presentes); demais opcionais.
function log(
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  const payload = JSON.stringify({ event, ...fields });
  const line = `[auto-review] ${payload}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

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

  const [
    { data: project },
    { data: humanResponse },
    { data: llmResponse },
    { data: equivalences },
  ] = await Promise.all([
    admin
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    admin
      .from("responses")
      .select("id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_id", humanUserId)
      .eq("respondent_type", "humano")
      .maybeSingle(),
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
  ]);

  if (!project?.pydantic_fields || !humanResponse || !llmResponse) {
    log(
      "skip_no_data",
      {
        projectId,
        documentId,
        userId: humanUserId,
        hasProject: !!project?.pydantic_fields,
        hasHuman: !!humanResponse,
        hasLlm: !!llmResponse,
      },
      "warn",
    );
    return { divergentCount: 0 };
  }

  const fields = project.pydantic_fields as PydanticField[];

  // Respeita equivalencias ja marcadas (aba Comparar ou veredito "equivalente"
  // da propria auto-revisao) — sem isto, um par marcado como equivalente
  // reapareceria como divergente.
  const equivalencesByField = new Map<string, EquivalencePair[]>();
  for (const eq of equivalences ?? []) {
    const list = equivalencesByField.get(eq.field_name) ?? [];
    list.push({
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
    });
    equivalencesByField.set(eq.field_name, list);
  }

  const divergent = computeDivergentFieldNames(
    fields,
    [
      {
        id: humanResponse.id,
        answers: humanResponse.answers ?? {},
        answerFieldHashes: humanResponse.answer_field_hashes as
          | Record<string, string>
          | null,
      },
      {
        id: llmResponse.id,
        answers: llmResponse.answers ?? {},
        answerFieldHashes: llmResponse.answer_field_hashes as
          | Record<string, string>
          | null,
      },
    ],
    equivalencesByField,
  );

  if (divergent.length === 0) {
    log("consensus", {
      projectId,
      documentId,
      userId: humanUserId,
      totalFields: fields.length,
    });
    return { divergentCount: 0 };
  }

  // Upsert assignment auto_revisao para o humano (idempotente via UNIQUE doc+user+type)
  const { error: asgErr } = await admin.from("assignments").upsert(
    {
      project_id: projectId,
      document_id: documentId,
      user_id: humanUserId,
      type: "auto_revisao",
      status: "pendente",
    },
    { onConflict: "document_id,user_id,type", ignoreDuplicates: true },
  );
  if (asgErr) {
    log(
      "assignment_upsert_failed",
      { projectId, documentId, userId: humanUserId, error: asgErr.message },
      "error",
    );
    throw new Error(asgErr.message);
  }

  // Upsert field_reviews stubs (1 por campo divergente)
  const rows = divergent.map((fieldName) => ({
    project_id: projectId,
    document_id: documentId,
    field_name: fieldName,
    human_response_id: humanResponse.id,
    llm_response_id: llmResponse.id,
    self_reviewer_id: humanUserId,
  }));

  const { error: frErr } = await admin.from("field_reviews").upsert(rows, {
    onConflict: "document_id,field_name",
    ignoreDuplicates: true,
  });
  if (frErr) {
    log(
      "field_reviews_upsert_failed",
      {
        projectId,
        documentId,
        userId: humanUserId,
        divergentCount: divergent.length,
        error: frErr.message,
      },
      "error",
    );
    throw new Error(frErr.message);
  }

  log("created", {
    projectId,
    documentId,
    userId: humanUserId,
    divergentCount: divergent.length,
    divergentFields: divergent,
  });

  return { divergentCount: divergent.length };
}
