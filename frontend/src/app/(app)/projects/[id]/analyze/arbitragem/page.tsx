import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ArbitrationPage } from "@/components/arbitration/ArbitrationPage";
import type { PydanticField } from "@/lib/types";

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

  const [{ data: docs }, { data: fieldReviews }, { data: responses }] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, external_id, text")
      .in("id", docIds)
      .is("excluded_at", null),
    supabase
      .from("field_reviews")
      .select(
        "id, document_id, field_name, human_response_id, llm_response_id, blind_verdict, final_verdict",
      )
      .in("document_id", docIds)
      .eq("arbitrator_id", user.id)
      .eq("self_verdict", "contesta_llm")
      .is("final_verdict", null),
    supabase
      .from("responses")
      .select("id, document_id, respondent_type, respondent_name, answers, justifications")
      .in("document_id", docIds),
  ]);

  const responsesById = new Map((responses ?? []).map((r) => [r.id, r]));

  type DocPayload = {
    docId: string;
    title: string | null;
    externalId: string | null;
    text: string;
    fields: Array<{
      fieldReviewId: string;
      fieldName: string;
      humanAnswer: unknown;
      humanName: string | null;
      llmAnswer: unknown;
      llmName: string | null;
      llmJustification: string | null;
      blindVerdict: "humano" | "llm" | null;
    }>;
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
    payload.fields.push({
      fieldReviewId: fr.id,
      fieldName: fr.field_name,
      humanAnswer:
        (human?.answers as Record<string, unknown>)?.[fr.field_name] ?? null,
      humanName: human?.respondent_name ?? null,
      llmAnswer:
        (llm?.answers as Record<string, unknown>)?.[fr.field_name] ?? null,
      llmName: llm?.respondent_name ?? null,
      llmJustification:
        (llm?.justifications as Record<string, string> | null)?.[
          fr.field_name
        ] ?? null,
      blindVerdict: (fr.blind_verdict as "humano" | "llm" | null) ?? null,
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
