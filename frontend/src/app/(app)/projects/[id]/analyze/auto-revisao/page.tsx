import { Suspense } from "react";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import {
  AutoReviewPage,
  type AutoReviewDoc,
  type AutoReviewQueueOwner,
} from "@/components/auto-review/AutoReviewPage";
import {
  buildReviewQueueDocumentMap,
  loadReviewQueueRows,
} from "@/lib/review-queue";
import type { PydanticField } from "@/lib/types";
import { requireResolvedProjectAccess } from "@/lib/project-access";

interface MemberRow {
  user_id: string;
  profiles: {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  };
}

interface AutoReviewFieldReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
  llm_justification_snapshot: unknown;
  self_verdict: string | null;
  self_justification: string | null;
}

function buildQueueOwners(
  memberRows: unknown[] | null,
  isCoordinator: boolean,
): AutoReviewQueueOwner[] {
  if (!isCoordinator) return [];

  return (memberRows ?? []).map((row) => {
    const member = row as MemberRow;
    const fullName = [member.profiles.first_name, member.profiles.last_name]
      .filter(Boolean)
      .join(" ");
    return {
      userId: member.user_id,
      email: member.profiles.email,
      name: fullName || null,
    };
  });
}

function buildAutoReviewDocuments(
  documents: Parameters<typeof buildReviewQueueDocumentMap>[0],
  fieldReviews: AutoReviewFieldReviewRow[],
  fields: PydanticField[],
): AutoReviewDoc[] {
  const fieldDescById = new Map(
    fields.map((field) => [field.name, field.description]),
  );
  const fieldHelpTextById = new Map(
    fields.map((field) => [field.name, field.help_text ?? null]),
  );
  const docMap =
    buildReviewQueueDocumentMap<AutoReviewDoc["fields"][number]>(documents);

  for (const review of fieldReviews) {
    const document = docMap.get(review.document_id);
    if (!document) continue;
    document.fields.push({
      fieldReviewId: review.id,
      fieldName: review.field_name,
      fieldDescription: fieldDescById.get(review.field_name) ?? null,
      fieldHelpText: fieldHelpTextById.get(review.field_name) ?? null,
      humanAnswer: review.human_answer_snapshot ?? null,
      llmAnswer: review.llm_answer_snapshot ?? null,
      llmJustification:
        typeof review.llm_justification_snapshot === "string"
          ? review.llm_justification_snapshot
          : null,
      alreadyAnswered: review.self_verdict !== null,
      selfJustification: review.self_justification ?? null,
    });
  }

  return Array.from(docMap.values()).filter((document) =>
    document.fields.some((field) => !field.alreadyAnswered),
  );
}

export default async function AutoReviewRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAs?: string }>;
}) {
  const [{ id }, { viewAs }, user] = await Promise.all([
    params,
    searchParams,
    requirePageAuthUser(),
  ]);

  const [supabase, accessResult] = await Promise.all([
    createSupabaseServer(),
    getProjectAccessContext(id, user),
  ]);
  const access = requireResolvedProjectAccess(accessResult);
  const { isCoordinator, memberUserId: ownQueueUserId } = access;

  // O viewAs desta tela pertence ao coordenador e tem precedência sobre a
  // identidade canônica. Sem ele, a fila pessoal resolve contas-alias como as
  // demais filas.
  const queueUserId = isCoordinator && viewAs ? viewAs : ownQueueUserId;

  const [{ data: project }, { data: pendingReviews }, { data: memberRows }] =
    await Promise.all([
      supabase.from("projects").select("pydantic_fields").eq("id", id).single(),
      supabase
        .from("field_reviews")
        .select("document_id")
        .eq("project_id", id)
        .eq("self_reviewer_id", queueUserId)
        .is("superseded_at", null)
        .is("self_verdict", null),
      isCoordinator
        ? supabase
            .from("project_members")
            .select("user_id, profiles!inner(id, email, first_name, last_name)")
            .eq("project_id", id)
        : Promise.resolve({ data: [] as Array<unknown> }),
    ]);

  const reviewers = buildQueueOwners(memberRows, isCoordinator);
  const docIds = Array.from(
    new Set((pendingReviews ?? []).map((review) => review.document_id)),
  );
  const { documents: docs, fieldReviews } = await loadReviewQueueRows(
    supabase,
    docIds,
    () =>
      supabase
        .from("field_reviews")
        .select(
          "id, document_id, field_name, human_answer_snapshot, llm_answer_snapshot, llm_justification_snapshot, self_verdict, self_justification",
        )
        .eq("project_id", id)
        .in("document_id", docIds)
        .eq("self_reviewer_id", queueUserId)
        .is("superseded_at", null),
  );
  const fieldsMeta = (project?.pydantic_fields as PydanticField[]) ?? [];
  const docsToReview = buildAutoReviewDocuments(
    docs,
    fieldReviews as AutoReviewFieldReviewRow[],
    fieldsMeta,
  );

  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-muted-foreground">Carregando…</div>
      }
    >
      <AutoReviewPage
        projectId={id}
        fields={fieldsMeta}
        docs={docsToReview}
        isCoordinator={isCoordinator}
        queueUserId={queueUserId}
        reviewers={reviewers}
        ownQueueUserId={ownQueueUserId}
      />
    </Suspense>
  );
}
