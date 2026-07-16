import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { isCodingComplete } from "@/lib/coding-completeness";
import type { EquivalencePair } from "@/lib/equivalence";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

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

  // #174: nunca arbitrar codificacao incompleta. O caminho inline (saveResponse)
  // ja so chama esta funcao apos allAnswered, mas a guarda evita regressao se a
  // funcao for chamada de outro ponto — e usa a mesma definicao de completude
  // (isCodingComplete) do gate inline e do backlog. Staleness-aware: passa
  // answer_field_hashes para nao reprovar codificacao completa a epoca por causa
  // de campo obrigatorio adicionado depois (mesmo motivo do backlog).
  if (
    !isCodingComplete(
      fields,
      (humanResponse.answers as Record<string, unknown>) ?? {},
      humanResponse.answer_field_hashes as AnswerFieldHashes,
    )
  ) {
    log("skip_incomplete_coding", {
      projectId,
      documentId,
      userId: humanUserId,
    });
    return { divergentCount: 0 };
  }

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
        answerFieldHashes: humanResponse.answer_field_hashes as AnswerFieldHashes,
      },
      {
        id: llmResponse.id,
        answers: llmResponse.answers ?? {},
        answerFieldHashes: llmResponse.answer_field_hashes as AnswerFieldHashes,
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

  // RPC porque stubs e assignment precisam da mesma transação e da mesma trava
  // que o fechamento pega — ver migration 20260716130000.
  const { error: assignErr } = await admin.rpc("assign_auto_review_if_eligible", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_self_reviewer_id: humanUserId,
    p_field_names: divergent,
    p_human_response_id: humanResponse.id,
    p_llm_response_id: llmResponse.id,
  });
  if (assignErr) {
    log(
      "auto_review_assign_failed",
      {
        projectId,
        documentId,
        userId: humanUserId,
        divergentCount: divergent.length,
        error: assignErr.message,
      },
      "error",
    );
    throw new Error(assignErr.message);
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
