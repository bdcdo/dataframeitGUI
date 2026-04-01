import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { CodingPage } from "@/components/coding/CodingPage";
import { getResearcherProgress } from "@/actions/progress";
import type { Document, Assignment, PydanticField } from "@/lib/types";

export default async function CodePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const isImpersonating = !!(user.isMaster && sp.viewAsUser);
  const effectiveUserId =
    isImpersonating ? sp.viewAsUser! : user.id;

  const supabase = await createSupabaseServer();

  // Round 1: project + assignments + progress in parallel
  const [{ data: project }, { data: assignments }, progressResult] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", id)
      .single(),
    supabase
      .from("assignments")
      .select("id, status, document_id, documents(id, external_id, title, text)")
      .eq("project_id", id)
      .eq("user_id", effectiveUserId)
      .eq("type", "codificacao")
      .order("status", { ascending: true }),
    getResearcherProgress(id, effectiveUserId).catch(() => null),
  ]);

  const documents = (assignments || []).map((a) => ({
    ...(a.documents as unknown as Document),
    assignment: { id: a.id, status: a.status } as Pick<Assignment, "id" | "status">,
  }));

  // Get existing responses for these documents
  const docIds = documents.map((d) => d.id);
  const { data: responses } = await supabase
    .from("responses")
    .select("document_id, answers, justifications")
    .eq("project_id", id)
    .eq("respondent_id", effectiveUserId)
    .in("document_id", docIds.length > 0 ? docIds : ["__none__"]);

  const rawAnswers: Record<string, Record<string, unknown>> = {};
  responses?.forEach((r) => {
    rawAnswers[r.document_id] = r.answers as Record<string, unknown>;
  });

  const existingJustifications: Record<string, Record<string, unknown>> = {};
  responses?.forEach((r) => {
    if (r.justifications) {
      existingJustifications[r.document_id] = r.justifications as Record<string, unknown>;
    }
  });

  // Sanitize: remove answers whose values don't match current schema options
  const fields = ((project?.pydantic_fields || []) as PydanticField[]).filter(
    (f) => f.target !== "llm_only"
  );
  const existingAnswers: Record<string, Record<string, unknown>> = {};
  for (const [docId, answers] of Object.entries(rawAnswers)) {
    const clean: Record<string, unknown> = {};
    for (const field of fields) {
      const val = answers[field.name];
      if (val === undefined || val === null) continue;
      if (field.type === "single" && field.options) {
        if (field.options.includes(val as string)) clean[field.name] = val;
      } else if (field.type === "multi" && field.options) {
        const arr = Array.isArray(val) ? val.filter((v: string) => field.options!.includes(v)) : [];
        if (arr.length > 0) clean[field.name] = arr;
      } else {
        clean[field.name] = val; // text fields: always keep
      }
    }
    existingAnswers[docId] = clean;
  }

  // Progress was fetched in parallel above
  let progress = null;
  if (documents.length > 0 && progressResult) {
    progress = {
      completed: progressResult.completed,
      total: progressResult.total,
      nextDeadline: progressResult.nextDeadline,
      daysUntilDeadline: progressResult.daysUntilDeadline,
      requiredPace: progressResult.requiredPace,
      streak: progressResult.streak,
    };
  }

  return (
    <CodingPage
      projectId={id}
      documents={documents}
      fields={fields}
      existingAnswers={existingAnswers}
      existingJustifications={existingJustifications}
      hasAssignments={documents.length > 0}
      progress={progress}
      readOnly={isImpersonating}
    />
  );
}
