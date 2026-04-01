import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { ReviewCommentsView } from "@/components/stats/ReviewCommentsView";
import type { ReviewComment } from "@/components/stats/CommentCard";
import type { PydanticField } from "@/lib/types";

export default async function CommentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  const supabase = await createSupabaseServer();

  const [
    { data: project },
    { data: reviews },
    { data: documents },
    { data: membership },
    { data: responsesWithNotes },
    { data: schemaChanges },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("reviews")
      .select(
        "id, document_id, field_name, verdict, comment, chosen_response_id, resolved_at, reviewer_id, created_at, response_snapshot",
      )
      .eq("project_id", id)
      .not("comment", "is", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", id),
    user
      ? supabase
          .from("project_members")
          .select("role")
          .eq("project_id", id)
          .eq("user_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("responses")
      .select("id, document_id, respondent_name, justifications, created_at")
      .eq("project_id", id)
      .eq("respondent_type", "humano")
      .not("justifications", "is", null),
    supabase
      .from("schema_change_log")
      .select("id, field_name, change_summary, before_value, after_value, created_at, profiles(first_name, last_name)")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  const fieldDescMap = new Map(fields.map((f) => [f.name, f.description]));
  const docMap = new Map(
    documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
  );

  // Fetch reviewer names
  const reviewerIds = [
    ...new Set(
      (reviews || [])
        .map((r) => r.reviewer_id)
        .filter((rid): rid is string => !!rid),
    ),
  ];

  const isCoordinator =
    project?.created_by === user?.id || membership?.role === "coordenador";

  let reviewerMap = new Map<string, string>();
  if (reviewerIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", reviewerIds);
    reviewerMap = new Map(
      profiles?.map((p) => [p.id, p.full_name || "Anônimo"]) || [],
    );
  }

  const reviewComments: ReviewComment[] = (reviews || []).map((r) => ({
    id: r.id,
    documentId: r.document_id,
    documentTitle: docMap.get(r.document_id) || r.document_id,
    fieldName: r.field_name,
    fieldDescription: fieldDescMap.get(r.field_name) || r.field_name,
    verdict: r.verdict,
    comment: r.comment!,
    reviewerName: r.reviewer_id
      ? reviewerMap.get(r.reviewer_id) || "Anônimo"
      : "Anônimo",
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    chosenResponseId: r.chosen_response_id,
    source: "review",
    responseSnapshot: (r.response_snapshot as ReviewComment["responseSnapshot"]) ?? null,
  }));

  const noteComments: ReviewComment[] = (responsesWithNotes || [])
    .filter((r) => {
      const j = r.justifications as Record<string, string> | null;
      return j && typeof j._notes === "string" && j._notes.trim().length > 0;
    })
    .map((r) => ({
      id: `nota-${r.id}`,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      fieldName: "(geral)",
      fieldDescription: "Nota do pesquisador",
      verdict: "nota",
      comment: (r.justifications as Record<string, string>)._notes,
      reviewerName: r.respondent_name || "Anônimo",
      resolvedAt: null,
      createdAt: r.created_at,
      chosenResponseId: null,
      source: "nota" as const,
      responseSnapshot: null,
    }));

  const comments = [...reviewComments, ...noteComments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const schemaLog = (schemaChanges || []).map((c) => {
    const p = c.profiles as unknown as { first_name: string | null; last_name: string | null } | null;
    return {
      id: c.id as string,
      fieldName: c.field_name as string,
      changeSummary: c.change_summary as string,
      beforeValue: c.before_value as Record<string, unknown>,
      afterValue: c.after_value as Record<string, unknown>,
      changedBy: [p?.first_name, p?.last_name].filter(Boolean).join(" ") || "Anônimo",
      createdAt: c.created_at as string,
    };
  });

  return (
    <div className="mx-auto max-w-4xl p-6">
      <ReviewCommentsView
        projectId={id}
        comments={comments}
        fields={fields}
        isCoordinator={isCoordinator}
        schemaLog={schemaLog}
      />
    </div>
  );
}
