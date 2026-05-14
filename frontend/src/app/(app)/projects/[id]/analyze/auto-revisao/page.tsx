import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  AutoReviewPage,
  type AutoReviewDoc,
  type AutoReviewQueueOwner,
} from "@/components/auto-review/AutoReviewPage";
import type { PydanticField } from "@/lib/types";

export default async function AutoReviewRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAs?: string }>;
}) {
  const { id } = await params;
  const { viewAs } = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();
  const isCoordinator = await isProjectCoordinator(id, user);

  // viewAs só é honrado para coordenadores; pesquisador sempre vê a própria fila.
  const targetUserId = isCoordinator && viewAs ? viewAs : user.id;

  const [{ data: project }, { data: assignments }, { data: memberRows }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("pydantic_fields")
        .eq("id", id)
        .single(),
      supabase
        .from("assignments")
        .select("document_id, status")
        .eq("project_id", id)
        .eq("user_id", targetUserId)
        .eq("type", "auto_revisao")
        .neq("status", "concluido"),
      isCoordinator
        ? supabase
            .from("project_members")
            .select("user_id, profiles!inner(id, email, first_name, last_name)")
            .eq("project_id", id)
        : Promise.resolve({ data: [] as Array<unknown> }),
    ]);

  const reviewers: AutoReviewQueueOwner[] = isCoordinator
    ? ((memberRows ?? []) as Array<{
        user_id: string;
        profiles: {
          id: string;
          email: string | null;
          first_name: string | null;
          last_name: string | null;
        };
      }>).map((m) => {
        const fullName = [m.profiles?.first_name, m.profiles?.last_name]
          .filter(Boolean)
          .join(" ");
        return {
          userId: m.user_id,
          email: m.profiles?.email ?? null,
          name: fullName || null,
        };
      })
    : [];

  const docIds = (assignments ?? []).map((a) => a.document_id);
  if (docIds.length === 0) {
    return (
      <AutoReviewPage
        projectId={id}
        fields={(project?.pydantic_fields as PydanticField[]) ?? []}
        docs={[]}
        isCoordinator={isCoordinator}
        viewAsUserId={targetUserId}
        reviewers={reviewers}
        currentUserId={user.id}
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
        "id, document_id, field_name, human_response_id, llm_response_id, self_verdict, self_justification",
      )
      .in("document_id", docIds)
      .eq("self_reviewer_id", targetUserId),
  ]);

  // Buscar só as respostas referenciadas (evita puxar todas as versões
  // históricas de humano/LLM dos docs).
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
          .select("id, document_id, respondent_type, answers, justifications")
          .in("id", responseIds)
      : { data: [] };

  const responsesById = new Map((responses ?? []).map((r) => [r.id, r]));

  const fieldsMeta = (project?.pydantic_fields as PydanticField[]) ?? [];
  const fieldDescById = new Map(fieldsMeta.map((f) => [f.name, f.description]));

  const docMap = new Map<string, AutoReviewDoc>();
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
      fieldDescription: fieldDescById.get(fr.field_name) ?? null,
      humanAnswer:
        (human?.answers as Record<string, unknown>)?.[fr.field_name] ?? null,
      llmAnswer:
        (llm?.answers as Record<string, unknown>)?.[fr.field_name] ?? null,
      llmJustification:
        (llm?.justifications as Record<string, string> | null)?.[
          fr.field_name
        ] ?? null,
      alreadyAnswered: fr.self_verdict !== null,
      selfJustification: fr.self_justification ?? null,
    });
  }

  // Só mostra docs com pelo menos um campo divergente não revisado.
  const docsToReview = Array.from(docMap.values()).filter((d) =>
    d.fields.some((f) => !f.alreadyAnswered),
  );

  return (
    <AutoReviewPage
      projectId={id}
      fields={fieldsMeta}
      docs={docsToReview}
      isCoordinator={isCoordinator}
      viewAsUserId={targetUserId}
      reviewers={reviewers}
      currentUserId={user.id}
    />
  );
}
