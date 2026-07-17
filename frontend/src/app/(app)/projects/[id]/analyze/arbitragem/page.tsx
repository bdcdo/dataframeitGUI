import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getProjectAccessContext,
  resolveProjectQueueIdentity,
} from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import {
  ArbitrationPage,
  type ArbitrationDoc,
  type ArbitrationField,
} from "@/components/arbitration/ArbitrationPage";
import { assignOrder } from "@/lib/arbitration-order";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import {
  buildReviewQueueDocumentMap,
  loadReviewQueueRows,
} from "@/lib/review-queue";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

// Server-side A/B embaralhamento da fase cega — o navegador nunca recebe os
// labels humano/llm enquanto blind_verdict IS NULL. Quando blind ja foi decidido,
// montamos o payload `reveal` com aSide/bSide + nomes + justificativa para a
// fase 2 trabalhar normalmente.

export default async function ArbitrationRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string }>;
}) {
  const [{ id }, sp, user, supabase] = await Promise.all([
    params,
    searchParams,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  // Fila 100% pessoal: pertence à identidade EFETIVA (impersonação master via
  // ?viewAsUser= ou conta-alias da spec 002), como no Codificar/Comparação.
  // Com user.id cru, o master "visualizando como" via a própria fila (vazia).
  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  const { queueUserId } = resolveProjectQueueIdentity(access, sp.viewAsUser);

  const [{ data: project }, { data: assignments }] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, name, arbitration_blind")
      .eq("id", id)
      .single(),
    supabase
      .from("assignments")
      .select("document_id, status")
      .eq("project_id", id)
      .eq("user_id", queueUserId)
      .eq("type", "arbitragem")
      .neq("status", "concluido"),
  ]);

  const docIds = (assignments ?? []).map((a) => a.document_id);
  const { documents: docs, fieldReviews } = await loadReviewQueueRows(
    supabase,
    docIds,
    () =>
      supabase
        .from("field_reviews")
        .select(
          "id, document_id, field_name, human_response_id, llm_response_id, human_answer_snapshot, llm_answer_snapshot, llm_justification_snapshot, blind_verdict, final_verdict, self_justification",
        )
        .in("document_id", docIds)
        .eq("arbitrator_id", queueUserId)
        .eq("self_verdict", "contesta_llm")
        .is("superseded_at", null)
        .is("final_verdict", null),
  );

  const responseIdSet = new Set<string>();
  for (const fr of fieldReviews) {
    responseIdSet.add(fr.human_response_id);
    responseIdSet.add(fr.llm_response_id);
  }
  const responseIds = Array.from(responseIdSet);
  const { data: responses } =
    responseIds.length > 0
      ? await supabase
          .from("responses")
          .select(
            "id, document_id, respondent_type, respondent_name, answers, justifications",
          )
          .in("id", responseIds)
      : { data: [] };

  const responsesById = new Map((responses ?? []).map((r) => [r.id, r]));

  const docMap = buildReviewQueueDocumentMap<ArbitrationField>(docs);

  for (const fr of fieldReviews) {
    const payload = docMap.get(fr.document_id);
    if (!payload) continue;
    const human = responsesById.get(fr.human_response_id);
    const llm = responsesById.get(fr.llm_response_id);

    const humanAnswer = fr.human_answer_snapshot;
    const llmAnswer = fr.llm_answer_snapshot;

    const order = assignOrder(fr.id);
    const aSide: ArbitrationVerdict =
      order === "human_first" ? "humano" : "llm";
    const bSide: ArbitrationVerdict =
      order === "human_first" ? "llm" : "humano";
    const aAnswer = order === "human_first" ? humanAnswer : llmAnswer;
    const bAnswer = order === "human_first" ? llmAnswer : humanAnswer;
    const blindVerdict =
      (fr.blind_verdict as ArbitrationVerdict | null) ?? null;

    payload.fields.push({
      fieldReviewId: fr.id,
      fieldName: fr.field_name,
      aAnswer,
      bAnswer,
      blindVerdict,
      reveal:
        blindVerdict !== null
          ? {
              aSide,
              bSide,
              humanName: human?.respondent_name ?? null,
              llmName: llm?.respondent_name ?? null,
              llmJustification:
                typeof fr.llm_justification_snapshot === "string"
                  ? fr.llm_justification_snapshot
                  : null,
              selfJustification: fr.self_justification ?? null,
            }
          : null,
    });
  }

  const arbitratableDocs: ArbitrationDoc[] = Array.from(docMap.values()).filter(
    (d) => d.fields.length > 0,
  );

  return (
    <ArbitrationPage
      projectId={id}
      projectName={project?.name ?? ""}
      fields={(project?.pydantic_fields as PydanticField[]) ?? []}
      docs={arbitratableDocs}
      arbitrationBlind={project?.arbitration_blind ?? true}
    />
  );
}
