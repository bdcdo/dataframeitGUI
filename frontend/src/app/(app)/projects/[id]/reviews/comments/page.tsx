import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { coordinatorGate } from "@/lib/project-access";
import { ReviewCommentsView } from "@/components/stats/ReviewCommentsView";
import type { PydanticField } from "@/lib/types";
import {
  mapReviewComments,
  mapNoteComments,
  mapSuggestionComments,
  mapDifficultyComments,
  mapDuvidaComments,
  mapProjectComments,
  buildOrderedComments,
  type ProjectCommentRow,
  type SuggestionRow,
  type VerdictQuestionRow,
} from "@/lib/reviews/comments-mapper";

export default async function CommentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    getAuthUser(),
    createSupabaseServer(),
  ]);

  const [
    { data: project },
    { data: reviews },
    { data: documents },
    { data: responsesWithNotes },
    { data: suggestions },
    { data: llmResponses },
    { data: difficultyResolutions },
    { data: projectComments },
    { data: verdictQuestions },
    { data: noteResolutions },
    accessContext,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
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
      .eq("is_latest", true),
    supabase
      .from("difficulty_resolutions")
      .select("response_id, resolved_at")
      .eq("project_id", id),
    supabase
      .from("project_comments")
      .select("id, document_id, field_name, author_id, body, parent_id, resolved_at, resolved_by, created_at, kind, rejected_at, rejected_reason, profiles!author_id(email)")
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
    user
      ? getProjectAccessContext(id, user.id, user.isMaster)
      : Promise.resolve(null),
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
      ...((reviews || []).flatMap((r) =>
        r.reviewer_id ? [r.reviewer_id] : [],
      )),
      ...((verdictQuestions || []).flatMap((q) =>
        q.respondent_id ? [q.respondent_id] : [],
      )),
    ]),
  ];

  // Fail-open em erro transitorio de query: nao rebaixa um coordenador legitimo
  // a nao-coordenador por falha transiente. Seguro aqui porque isCoordinator so
  // liga affordances no ReviewCommentsView (a view nao recorta dados por papel)
  // e as mutacoes por tras delas re-checam via isProjectCoordinator (fail-closed).
  // NB: ao contrario de config/rounds, o layout-pai reviews/layout.tsx NAO
  // gateia coordenador (so faz `if (!user) redirect`) — a seguranca do fail-open
  // aqui depende inteiramente do affordance-only acima, nao de um backstop no layout.
  const isCoordinator = coordinatorGate(accessContext, { failOpen: true });

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

  const reviewComments = mapReviewComments(reviews || [], docMap, fieldMap, reviewerMap);

  const noteComments = mapNoteComments(responsesWithNotes || [], docMap, noteResolvedMap);

  const suggestionComments = mapSuggestionComments(
    (suggestions || []) as unknown as SuggestionRow[],
    fieldMap,
  );

  const resolvedDiffMap = new Map(
    difficultyResolutions?.map((d) => [d.response_id, d.resolved_at]) || [],
  );
  const difficultyComments = mapDifficultyComments(
    llmResponses || [],
    docMap,
    fieldMap,
    resolvedDiffMap,
  );

  const duvidaComments = mapDuvidaComments(
    (verdictQuestions || []) as unknown as VerdictQuestionRow[],
    docMap,
    fieldMap,
    reviewerMap,
  );

  const typedProjectComments = (projectComments ||
    []) as unknown as ProjectCommentRow[];

  const exclusionRows = typedProjectComments.filter(
    (c) => c.kind === "exclusion_request",
  );
  const noteRows = typedProjectComments.filter(
    (c) => c.kind !== "exclusion_request",
  );

  // Buscar titulos de docs excluidos referenciados por exclusion_requests resolvidas
  const excludedDocIds = exclusionRows.flatMap((c) =>
    c.document_id && !docMap.has(c.document_id) ? [c.document_id] : [],
  );
  const excludedDocTitles = new Map<string, string>();
  if (excludedDocIds.length > 0) {
    const { data: excludedDocs } = await supabase
      .from("documents")
      .select("id, title, external_id")
      .in("id", excludedDocIds);
    for (const d of excludedDocs || []) {
      excludedDocTitles.set(d.id, d.title || d.external_id || d.id);
    }
  }

  const { annotationComments, exclusionComments } = mapProjectComments(
    { exclusionRows, noteRows },
    docMap,
    excludedDocTitles,
    fieldMap,
  );

  const comments = buildOrderedComments({
    reviewComments,
    noteComments,
    difficultyComments,
    duvidaComments,
    annotationComments,
    suggestionComments,
    exclusionComments,
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
        totalLlmDocs={totalLlmDocs}
        llmDocsWithoutAmbiguities={llmDocsWithoutAmbiguities}
      />
    </div>
  );
}
