import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ArbitrationPage } from "@/components/arbitration/ArbitrationPage";
import { assignOrder } from "@/lib/arbitration-order";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

// Server-side A/B embaralhamento da fase cega — o navegador nunca recebe os
// labels humano/llm enquanto blind_verdict IS NULL. Quando blind ja foi decidido,
// montamos o payload `reveal` com aSide/bSide + nomes + justificativa para a
// fase 2 trabalhar normalmente.

export default async function ArbitrationRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

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
      .eq("user_id", user.id)
      .eq("type", "arbitragem")
      .neq("status", "concluido"),
  ]);

  const docIds = (assignments ?? []).map((a) => a.document_id);
  if (docIds.length === 0) {
    return (
      <ArbitrationPage
        projectId={id}
        projectName={project?.name ?? ""}
        fields={(project?.pydantic_fields as PydanticField[]) ?? []}
        docs={[]}
        arbitrationBlind={project?.arbitration_blind ?? true}
      />
    );
  }

  const [{ data: docs }, { data: fieldReviews }] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, external_id, text")
      .in("id", docIds)
      .is("excluded_at", null),
    supabase
      .from("field_reviews")
      .select(
        "id, document_id, field_name, human_response_id, llm_response_id, blind_verdict, final_verdict, self_justification",
      )
      .in("document_id", docIds)
      .eq("arbitrator_id", user.id)
      .eq("self_verdict", "contesta_llm")
      .is("final_verdict", null),
  ]);

  const responseIdSet = new Set<string>();
  for (const fr of fieldReviews ?? []) {
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

  type ArbitrationFieldPayload = {
    fieldReviewId: string;
    fieldName: string;
    aAnswer: unknown;
    bAnswer: unknown;
    blindVerdict: ArbitrationVerdict | null;
    // Populado apenas quando blind_verdict ja existe (fase 2). Na fase cega
    // este campo e null — o navegador nao recebe a relacao A/B ↔ humano/llm.
    reveal: {
      aSide: ArbitrationVerdict;
      bSide: ArbitrationVerdict;
      humanName: string | null;
      llmName: string | null;
      llmJustification: string | null;
      selfJustification: string | null;
    } | null;
  };

  type DocPayload = {
    docId: string;
    title: string | null;
    externalId: string | null;
    text: string;
    fields: ArbitrationFieldPayload[];
  };

  const docMap = new Map<string, DocPayload>();
  for (const d of docs ?? []) {
    docMap.set(d.id, {
      docId: d.id,
      title: d.title,
      externalId: d.external_id,
      text: d.text,
      fields: [],
    });
  }

  for (const fr of fieldReviews ?? []) {
    const payload = docMap.get(fr.document_id);
    if (!payload) continue;
    const human = responsesById.get(fr.human_response_id);
    const llm = responsesById.get(fr.llm_response_id);

    const humanAnswer =
      (human?.answers as Record<string, unknown>)?.[fr.field_name] ?? null;
    const llmAnswer =
      (llm?.answers as Record<string, unknown>)?.[fr.field_name] ?? null;

    const order = assignOrder(fr.id);
    const aSide: ArbitrationVerdict = order === "human_first" ? "humano" : "llm";
    const bSide: ArbitrationVerdict = order === "human_first" ? "llm" : "humano";
    const aAnswer = order === "human_first" ? humanAnswer : llmAnswer;
    const bAnswer = order === "human_first" ? llmAnswer : humanAnswer;
    const blindVerdict = (fr.blind_verdict as ArbitrationVerdict | null) ?? null;

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
                (llm?.justifications as Record<string, string> | null)?.[
                  fr.field_name
                ] ?? null,
              selfJustification: fr.self_justification ?? null,
            }
          : null,
    });
  }

  const arbitratableDocs = Array.from(docMap.values()).filter(
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
