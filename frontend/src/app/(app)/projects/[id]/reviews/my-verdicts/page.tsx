import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { MyVerdictsView } from "@/components/reviews/MyVerdictsView";
import { isAnswerCorrect } from "@/lib/reviews/queries";
import type { PydanticField } from "@/lib/types";

export interface VerdictItem {
  reviewId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fieldType: "single" | "multi" | "text" | "date";
  verdict: string;
  coordinatorComment: string | null;
  myAnswer: unknown;
  isCorrect: boolean;
  responseSnapshot: Array<{
    id: string;
    respondent_name: string;
    respondent_type: "humano" | "llm";
    answer: unknown;
    justification?: string;
  }> | null;
  acknowledgmentStatus: "pending" | "accepted" | "questioned" | null;
  acknowledgmentComment: string | null;
}

export default async function MyVerdictsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getAuthUser();
  if (!user) return <p className="p-6 text-sm text-muted-foreground">Não autenticado</p>;

  const supabase = await createSupabaseServer();

  // First fetch project + membership to determine role
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("project_members")
      .select("role")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const isCoordinator =
    project?.created_by === user.id || membership?.role === "coordenador";

  const effectiveUserId =
    (user.isMaster || isCoordinator) && sp.viewAsUser ? sp.viewAsUser : user.id;

  // Fetch responses for the effective user
  const { data: myResponses } = await supabase
    .from("responses")
    .select("document_id, answers")
    .eq("project_id", id)
    .eq("respondent_id", effectiveUserId)
    .eq("respondent_type", "humano")
    .eq("is_current", true);

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const fieldDescMap = new Map(fields.map((f) => [f.name, f.description]));
  const fieldTypeMap = new Map(fields.map((f) => [f.name, (f.type || "text") as VerdictItem["fieldType"]]));

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
      .select("id, document_id, field_name, verdict, comment, response_snapshot, chosen_response_id")
      .eq("project_id", id)
      .in("document_id", myDocIds),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .in("id", myDocIds),
    supabase
      .from("verdict_acknowledgments")
      .select("review_id, status, comment")
      .eq("respondent_id", effectiveUserId),
    isCoordinator
      ? supabase
          .from("responses")
          .select("respondent_id, respondent_name")
          .eq("project_id", id)
          .eq("respondent_type", "humano")
          .eq("is_current", true)
      : Promise.resolve({ data: null }),
  ]);

  // Deduplicate respondents
  const respondentsList = isCoordinator && allRespondents
    ? [...new Map(
        allRespondents
          .filter((r) => r.respondent_id && r.respondent_id !== user.id)
          .map((r) => [r.respondent_id, { id: r.respondent_id as string, name: r.respondent_name || "Anônimo" }]),
      ).values()]
    : [];

  const docMap = new Map(
    documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
  );
  const ackMap = new Map(
    acknowledgments?.map((a) => [a.review_id, { status: a.status, comment: a.comment }]) || [],
  );
  const myAnswersMap = new Map(
    myResponses?.map((r) => [r.document_id, r.answers as Record<string, unknown>]) || [],
  );

  // Build verdict items
  const verdictItems = (reviews || [])
    .map((r) => {
      const myAnswers = myAnswersMap.get(r.document_id);
      if (!myAnswers) return null;
      const myAnswer = myAnswers[r.field_name];
      if (myAnswer === undefined) return null;

      const fieldType = fieldTypeMap.get(r.field_name) || "text";
      const isCorrect = isAnswerCorrect(myAnswer, r.verdict, fieldType);

      const ack = ackMap.get(r.id);

      return {
        reviewId: r.id,
        documentId: r.document_id,
        documentTitle: docMap.get(r.document_id) || r.document_id,
        fieldName: r.field_name,
        fieldDescription: fieldDescMap.get(r.field_name) || r.field_name,
        fieldType: fieldTypeMap.get(r.field_name) || "text",
        verdict: r.verdict,
        coordinatorComment: r.comment,
        myAnswer,
        isCorrect,
        responseSnapshot: r.response_snapshot as VerdictItem["responseSnapshot"],
        acknowledgmentStatus: (ack?.status as VerdictItem["acknowledgmentStatus"]) ?? null,
        acknowledgmentComment: ack?.comment ?? null,
      };
    })
    .filter((v) => v !== null) as VerdictItem[];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <MyVerdictsView
        projectId={id}
        items={verdictItems}
        fields={fields}
        userName={[user.firstName, user.lastName].filter(Boolean).join(" ") || "Você"}
        isCoordinator={isCoordinator}
        respondents={respondentsList}
        currentViewUserId={effectiveUserId !== user.id ? effectiveUserId : undefined}
      />
    </div>
  );
}
