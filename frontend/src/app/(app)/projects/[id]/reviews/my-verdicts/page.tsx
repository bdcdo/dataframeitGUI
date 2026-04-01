import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { MyVerdictsView } from "@/components/reviews/MyVerdictsView";
import type { PydanticField } from "@/lib/types";

export interface VerdictItem {
  reviewId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  verdict: string;
  coordinatorComment: string | null;
  myAnswer: unknown;
  isCorrect: boolean;
  responseSnapshot: Array<{
    id: string;
    respondent_name: string;
    respondent_type: "humano" | "llm";
    answer: unknown;
  }> | null;
  acknowledgmentStatus: "pending" | "accepted" | "questioned" | null;
  acknowledgmentComment: string | null;
}

function normalizeForComparison(answer: unknown): string {
  if (typeof answer === "string") return JSON.stringify(answer.trim());
  if (Array.isArray(answer))
    return JSON.stringify(answer.map((v) => (typeof v === "string" ? v.trim() : v)));
  return JSON.stringify(answer);
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

  const effectiveUserId =
    user.isMaster && sp.viewAsUser ? sp.viewAsUser : user.id;

  const supabase = await createSupabaseServer();

  // Fetch my responses, reviews on those documents, and my acknowledgments
  const [
    { data: project },
    { data: myResponses },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", id)
      .single(),
    supabase
      .from("responses")
      .select("document_id, answers")
      .eq("project_id", id)
      .eq("respondent_id", effectiveUserId)
      .eq("respondent_type", "humano")
      .eq("is_current", true),
  ]);

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const fieldDescMap = new Map(fields.map((f) => [f.name, f.description]));

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

  // Fetch reviews for those documents + document titles + my acknowledgments
  const [
    { data: reviews },
    { data: documents },
    { data: acknowledgments },
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
  ]);

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

      const isCorrect =
        r.verdict === "ambiguo" ||
        r.verdict === "pular" ||
        normalizeForComparison(myAnswer) === normalizeForComparison(r.verdict);

      const ack = ackMap.get(r.id);

      return {
        reviewId: r.id,
        documentId: r.document_id,
        documentTitle: docMap.get(r.document_id) || r.document_id,
        fieldName: r.field_name,
        fieldDescription: fieldDescMap.get(r.field_name) || r.field_name,
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
      />
    </div>
  );
}
