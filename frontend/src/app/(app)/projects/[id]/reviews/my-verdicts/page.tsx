import { Suspense } from "react";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { MyVerdictsView } from "@/components/reviews/MyVerdictsView";
import { resolveViewedRespondentId } from "@/lib/reviews/queries";
import { buildMyVerdictItems, type MyVerdictReviewRow } from "@/lib/reviews/my-verdicts";
import type { PydanticField } from "@/lib/types";

export type { VerdictItem } from "@/lib/reviews/my-verdicts";

export default async function MyVerdictsPage({
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

  // Project fields + papel do usuario. isCoordinator vem de
  // getProjectAccessContext (request-scoped via cache()) — reaproveita a
  // leitura project+membership ja feita pelo layout pai e cobre isMaster.
  // Fail-CLOSED aqui (ao contrario de comments/llm-insights): isCoordinator
  // gateia viewAsUser, que le o gabarito de OUTRO respondente. A policy RLS
  // "Members view responses" deixa qualquer membro ler todas as responses (nao
  // filtra por respondent_id), entao o recorte por viewedRespondentId e so
  // aplicacional — fail-open exporia gabarito de terceiros em erro transitorio.
  const [{ data: project }, rawAccess] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", id)
      .single(),
    getProjectAccessContext(id, user),
  ]);
  const access = requireResolvedProjectAccess(rawAccess);
  const { isCoordinator, memberUserId } = access;

  const viewedRespondentId = resolveViewedRespondentId({
    ownMemberUserId: memberUserId,
    isCoordinator,
    viewAsUser: sp.viewAsUser,
  });

  // Fetch responses for the effective user
  const { data: myResponses } = await supabase
    .from("responses")
    .select("document_id, answers")
    .eq("project_id", id)
    .eq("respondent_id", viewedRespondentId)
    .eq("respondent_type", "humano")
    .eq("is_latest", true);

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  // Get document IDs where I have responses
  const myDocIds = [...new Set((myResponses || []).map((r) => r.document_id))];
  if (myDocIds.length === 0) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhuma resposta submetida ainda.
        </p>
      </div>
    );
  }

  // Fetch reviews for those documents + document titles + my acknowledgments + respondents (for coordinator)
  const [
    { data: reviews },
    { data: documents },
    { data: acknowledgments },
    { data: allRespondents },
  ] = await Promise.all([
    supabase
      .from("reviews")
      .select("id, document_id, field_name, verdict, comment, response_snapshot, created_at, field_hash")
      .eq("project_id", id)
      .in("document_id", myDocIds),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .in("id", myDocIds)
      .is("excluded_at", null)
      .is("exclusion_pending_at", null),
    supabase
      .from("verdict_acknowledgments")
      .select("review_id, status, comment")
      .eq("respondent_id", viewedRespondentId),
    isCoordinator
      ? supabase
          .from("responses")
          .select("respondent_id, respondent_name")
          .eq("project_id", id)
          .eq("respondent_type", "humano")
          .eq("is_latest", true)
      : Promise.resolve({ data: null }),
  ]);

  // Deduplicate respondents
  const respondentsList = isCoordinator && allRespondents
    ? [...new Map(
        allRespondents
          .filter((r) => r.respondent_id && r.respondent_id !== memberUserId)
          .map((r) => [r.respondent_id, { id: r.respondent_id as string, name: r.respondent_name || "Anônimo" }]),
      ).values()]
    : [];

  const verdictItems = buildMyVerdictItems({
    reviews: (reviews ?? []) as MyVerdictReviewRow[],
    fields,
    myAnswersByDoc: new Map(
      myResponses?.map((r) => [r.document_id, r.answers as Record<string, unknown>]) || [],
    ),
    docTitles: new Map(
      documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
    ),
    acknowledgments: new Map(
      acknowledgments?.map((a) => [a.review_id, { status: a.status, comment: a.comment }]) || [],
    ),
  });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <Suspense fallback={<div className="text-sm text-muted-foreground">Carregando…</div>}>
        <MyVerdictsView
          projectId={id}
          items={verdictItems}
          fields={fields}
          userName={[user.firstName, user.lastName].filter(Boolean).join(" ") || "Você"}
          isCoordinator={isCoordinator}
          respondents={respondentsList}
          currentViewUserId={
            viewedRespondentId !== memberUserId
              ? viewedRespondentId
              : undefined
          }
        />
      </Suspense>
    </div>
  );
}
