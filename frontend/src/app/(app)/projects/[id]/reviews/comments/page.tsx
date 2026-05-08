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
    { data: suggestions },
    { data: llmResponses },
    { data: difficultyResolutions },
    { data: projectComments },
    { data: verdictQuestions },
    { data: noteResolutions },
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
      .eq("project_id", id)
      .is("excluded_at", null),
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
      .from("schema_suggestions")
      .select("id, field_name, suggested_changes, reason, status, resolved_at, created_at, profiles!suggested_by(email)")
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
    supabase
      .from("verdict_acknowledgments")
      .select(
        "review_id, respondent_id, comment, resolved_at, created_at, reviews!inner(id, project_id, document_id, field_name, verdict)",
      )
      .eq("status", "questioned")
      .not("comment", "is", null)
      .eq("reviews.project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("note_resolutions")
      .select("response_id, resolved_at")
      .eq("project_id", id),
  ]);

  const noteResolvedMap = new Map(
    (noteResolutions || []).map((n) => [n.response_id, n.resolved_at]),
  );

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const docMap = new Map(
    documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
  );

  // Fetch reviewer and respondent (dúvida author) names
  const reviewerIds = [
    ...new Set([
      ...((reviews || [])
        .map((r) => r.reviewer_id)
        .filter((rid): rid is string => !!rid)),
      ...((verdictQuestions || [])
        .map((q) => q.respondent_id)
        .filter((rid): rid is string => !!rid)),
    ]),
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
      resolvedAt: noteResolvedMap.get(r.id) ?? null,
      createdAt: r.created_at,
      chosenResponseId: null,
      source: "nota" as const,
      responseSnapshot: null,
    }));

  // Map suggestions as comments
  const suggestionComments: ReviewComment[] = (suggestions || []).map((s) => {
    const p = s.profiles as unknown as { email: string | null } | null;
    const changes = s.suggested_changes as Record<string, unknown>;
    const currentField = fieldMap.get(s.field_name);
    return {
      id: `sugestao-${s.id}`,
      documentId: "",
      documentTitle: "",
      fieldName: s.field_name,
      fieldDescription: currentField?.description || s.field_name,
      fieldHelpText: currentField?.help_text,
      fieldOptions: currentField?.options,
      fieldType: currentField?.type,
      verdict: "sugestao",
      comment: s.reason || "Sem motivo",
      reviewerName: p?.email?.split("@")[0] || "Anônimo",
      resolvedAt: (s.resolved_at as string | null) ?? null,
      createdAt: s.created_at,
      chosenResponseId: null,
      source: "sugestao" as const,
      responseSnapshot: null,
      suggestionId: s.id as string,
      suggestionStatus: s.status as "pending" | "approved" | "rejected",
      suggestionChanges: {
        description:
          typeof changes.description === "string" ? changes.description : undefined,
        help_text:
          changes.help_text === null || typeof changes.help_text === "string"
            ? (changes.help_text as string | null)
            : undefined,
        options: Array.isArray(changes.options)
          ? (changes.options as string[])
          : changes.options === null
            ? null
            : undefined,
      },
      fieldSnapshot: {
        description: currentField?.description ?? "",
        help_text: currentField?.help_text ?? null,
        options: currentField?.options ?? null,
      },
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

  // Map verdict_acknowledgments (dúvidas do Meu Gabarito) as ReviewComment
  type VerdictQuestionRow = {
    review_id: string;
    respondent_id: string;
    comment: string;
    resolved_at: string | null;
    created_at: string;
    reviews: {
      id: string;
      document_id: string;
      field_name: string;
      verdict: string;
    };
  };
  const duvidaComments: ReviewComment[] = ((verdictQuestions || []) as unknown as VerdictQuestionRow[]).map((q) => {
    const r = q.reviews;
    return {
      id: `duvida-${q.review_id}-${q.respondent_id}`,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      fieldName: r.field_name,
      fieldDescription: fieldMap.get(r.field_name)?.description || r.field_name,
      fieldHelpText: fieldMap.get(r.field_name)?.help_text,
      fieldOptions: fieldMap.get(r.field_name)?.options,
      fieldType: fieldMap.get(r.field_name)?.type,
      verdict: "duvida",
      comment: q.comment,
      reviewerName: reviewerMap.get(q.respondent_id) || "Anônimo",
      resolvedAt: q.resolved_at,
      createdAt: q.created_at,
      chosenResponseId: null,
      source: "duvida" as const,
      responseSnapshot: null,
      duvidaReviewId: q.review_id,
      duvidaRespondentId: q.respondent_id,
    };
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
    ...duvidaComments,
    ...annotationComments,
    ...suggestionComments.filter((s) => s.suggestionStatus !== "pending"),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const comments = [...pendingSuggestions, ...restComments];

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
        totalLlmDocs={totalLlmDocs}
        llmDocsWithoutAmbiguities={llmDocsWithoutAmbiguities}
      />
    </div>
  );
}
