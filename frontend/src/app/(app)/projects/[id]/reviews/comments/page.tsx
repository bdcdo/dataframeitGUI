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
    { data: suggestions },
    { data: llmResponses },
    { data: difficultyResolutions },
    { data: projectComments },
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
    supabase
      .from("schema_suggestions")
      .select("id, field_name, suggested_changes, reason, status, created_at, profiles!suggested_by(email)")
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("responses")
      .select("id, document_id, answers, respondent_name, created_at")
      .eq("project_id", id)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
    supabase
      .from("difficulty_resolutions")
      .select("response_id, resolved_at")
      .eq("project_id", id),
    supabase
      .from("project_comments")
      .select("id, document_id, field_name, author_id, body, parent_id, resolved_at, resolved_by, created_at, profiles!author_id(email)")
      .eq("project_id", id)
      .is("parent_id", null)
      .order("created_at", { ascending: false }),
  ]);

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  const fieldMap = new Map(fields.map((f) => [f.name, f]));
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
      .select("id, email")
      .in("id", reviewerIds);
    reviewerMap = new Map(
      profiles?.map((p) => [p.id, p.email?.split("@")[0] || "Anônimo"]) || [],
    );
  }

  const reviewComments: ReviewComment[] = (reviews || []).map((r) => ({
    id: r.id,
    documentId: r.document_id,
    documentTitle: docMap.get(r.document_id) || r.document_id,
    fieldName: r.field_name,
    fieldDescription: fieldMap.get(r.field_name)?.description || r.field_name,
    fieldHelpText: fieldMap.get(r.field_name)?.help_text,
    fieldOptions: fieldMap.get(r.field_name)?.options,
    fieldType: fieldMap.get(r.field_name)?.type,
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

  // Map suggestions as comments
  const suggestionComments: ReviewComment[] = (suggestions || []).map((s) => {
    const p = s.profiles as unknown as { email: string | null } | null;
    const changes = s.suggested_changes as Record<string, unknown>;
    const changedKeys = Object.keys(changes).join(", ");
    return {
      id: `sugestao-${s.id}`,
      documentId: "",
      documentTitle: "",
      fieldName: s.field_name,
      fieldDescription: fieldMap.get(s.field_name)?.description || s.field_name,
      fieldHelpText: fieldMap.get(s.field_name)?.help_text,
      fieldOptions: fieldMap.get(s.field_name)?.options,
      fieldType: fieldMap.get(s.field_name)?.type,
      verdict: "sugestao",
      comment: `${s.reason || "Sem motivo"}${changedKeys ? ` (alterações: ${changedKeys})` : ""}`,
      reviewerName: p?.email?.split("@")[0] || "Anônimo",
      resolvedAt: null,
      createdAt: s.created_at,
      chosenResponseId: null,
      source: "sugestao" as const,
      responseSnapshot: null,
      suggestionId: s.id as string,
      suggestionStatus: s.status as "pending" | "approved" | "rejected",
    };
  });

  // Build difficulty comments from LLM responses
  const resolvedDiffMap = new Map(
    difficultyResolutions?.map((d) => [d.response_id, d.resolved_at]) || [],
  );

  const difficultyComments: ReviewComment[] = [];
  llmResponses?.forEach((r) => {
    const ambiguidades = (r.answers as Record<string, unknown>)?.llm_ambiguidades;
    if (
      !ambiguidades ||
      (typeof ambiguidades === "string" && !ambiguidades.trim())
    )
      return;
    difficultyComments.push({
      id: `dificuldade-${r.id}`,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      fieldName: "(geral)",
      fieldDescription: "Dificuldade do LLM",
      verdict: "dificuldade",
      comment: String(ambiguidades),
      reviewerName: r.respondent_name || "LLM",
      resolvedAt: resolvedDiffMap.get(r.id) || null,
      createdAt: r.created_at,
      chosenResponseId: null,
      source: "dificuldade" as const,
      responseSnapshot: null,
      difficultyResponseId: r.id,
      difficultyDocumentId: r.document_id,
    });
  });

  // Map project_comments (anotações soltas) as ReviewComment
  const annotationComments: ReviewComment[] = (projectComments || []).map((c) => {
    const p = c.profiles as unknown as { email: string | null } | null;
    return {
      id: `anotacao-${c.id}`,
      documentId: c.document_id || "",
      documentTitle: c.document_id ? docMap.get(c.document_id) || c.document_id : "",
      fieldName: c.field_name || "(geral)",
      fieldDescription: c.field_name
        ? fieldMap.get(c.field_name)?.description || c.field_name
        : "Anotação livre",
      verdict: "anotacao",
      comment: c.body,
      reviewerName: p?.email?.split("@")[0] || "Anônimo",
      resolvedAt: c.resolved_at,
      createdAt: c.created_at,
      chosenResponseId: null,
      source: "anotacao" as const,
      responseSnapshot: null,
    };
  });

  // Pending suggestions first, then all others by date
  const pendingSuggestions = suggestionComments.filter(
    (s) => s.suggestionStatus === "pending",
  );
  const restComments = [
    ...reviewComments,
    ...noteComments,
    ...difficultyComments,
    ...annotationComments,
    ...suggestionComments.filter((s) => s.suggestionStatus !== "pending"),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const comments = [...pendingSuggestions, ...restComments];

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

  const totalLlmDocs = llmResponses?.length ?? 0;
  const llmDocsWithoutAmbiguities = (llmResponses ?? []).filter((r) => {
    const amb = (r.answers as Record<string, unknown>)?.llm_ambiguidades;
    return !amb || (typeof amb === "string" && !amb.trim());
  }).length;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <ReviewCommentsView
        projectId={id}
        comments={comments}
        fields={fields}
        isCoordinator={isCoordinator}
        schemaLog={schemaLog}
        totalLlmDocs={totalLlmDocs}
        llmDocsWithoutAmbiguities={llmDocsWithoutAmbiguities}
      />
    </div>
  );
}
