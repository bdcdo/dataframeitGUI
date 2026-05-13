import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AutoReviewPage } from "@/components/auto-review/AutoReviewPage";
import type { PydanticField } from "@/lib/types";

export default async function AutoReviewRoute({
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
      .select("pydantic_fields, name")
      .eq("id", id)
      .single(),
    supabase
      .from("assignments")
      .select("document_id, status")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .eq("type", "auto_revisao")
      .neq("status", "concluido"),
  ]);

  const docIds = (assignments ?? []).map((a) => a.document_id);
  if (docIds.length === 0) {
    return (
      <AutoReviewPage
        projectId={id}
        projectName={project?.name ?? ""}
        fields={(project?.pydantic_fields as PydanticField[]) ?? []}
        docs={[]}
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
        "id, document_id, field_name, human_response_id, llm_response_id, self_verdict",
      )
      .in("document_id", docIds)
      .eq("self_reviewer_id", user.id),
    supabase
      .from("responses")
      .select("id, document_id, respondent_type, answers, justifications")
      .in("document_id", docIds)
      .or(`respondent_id.eq.${user.id},respondent_type.eq.llm`),
  ]);

  // Para cada doc, agrupar field_reviews pendentes + answers humana/LLM
  const responsesById = new Map((responses ?? []).map((r) => [r.id, r]));

  type DocPayload = {
    docId: string;
    title: string | null;
    externalId: string | null;
    text: string;
    fields: Array<{
      fieldName: string;
      humanAnswer: unknown;
      llmAnswer: unknown;
      llmJustification: string | null;
      alreadyAnswered: boolean;
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
      fieldName: fr.field_name,
      humanAnswer:
        (human?.answers as Record<string, unknown>)?.[fr.field_name] ?? null,
      llmAnswer:
        (llm?.answers as Record<string, unknown>)?.[fr.field_name] ?? null,
      llmJustification:
        (llm?.justifications as Record<string, string> | null)?.[
          fr.field_name
        ] ?? null,
      alreadyAnswered: fr.self_verdict !== null,
    });
  }

  // So mostra docs com pelo menos um campo divergente nao revisado
  const docsToReview = Array.from(docMap.values()).filter((d) =>
    d.fields.some((f) => !f.alreadyAnswered),
  );

  return (
    <AutoReviewPage
      projectId={id}
      projectName={project?.name ?? ""}
      fields={(project?.pydantic_fields as PydanticField[]) ?? []}
      docs={docsToReview}
    />
  );
}
