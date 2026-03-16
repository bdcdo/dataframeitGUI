import { createSupabaseServer } from "@/lib/supabase/server";
import { CodingPage } from "@/components/coding/CodingPage";
import { getResearcherProgress } from "@/actions/progress";
import type { Document, Assignment, PydanticField } from "@/lib/types";

export default async function CodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Get project fields
  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_fields")
    .eq("id", id)
    .single();

  // Get assigned documents for current user
  const { data: assignments } = await supabase
    .from("assignments")
    .select("*, documents(*)")
    .eq("project_id", id)
    .eq("user_id", user!.id)
    .order("status", { ascending: true });

  const documents = (assignments || []).map((a) => ({
    ...(a.documents as unknown as Document),
    assignment: { id: a.id, status: a.status } as Pick<Assignment, "id" | "status">,
  }));

  // Get existing responses for these documents
  const docIds = documents.map((d) => d.id);
  const { data: responses } = await supabase
    .from("responses")
    .select("*")
    .eq("project_id", id)
    .eq("respondent_id", user!.id)
    .in("document_id", docIds.length > 0 ? docIds : ["__none__"]);

  const rawAnswers: Record<string, Record<string, unknown>> = {};
  responses?.forEach((r) => {
    rawAnswers[r.document_id] = r.answers as Record<string, unknown>;
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

  // Get progress data
  let progress = null;
  if (documents.length > 0) {
    try {
      const full = await getResearcherProgress(id);
      progress = {
        completed: full.completed,
        total: full.total,
        nextDeadline: full.nextDeadline,
        daysUntilDeadline: full.daysUntilDeadline,
        requiredPace: full.requiredPace,
        streak: full.streak,
      };
    } catch {
      // Progress is optional, don't break the page
    }
  }

  return (
    <CodingPage
      projectId={id}
      documents={documents}
      fields={fields}
      existingAnswers={existingAnswers}
      hasAssignments={documents.length > 0}
      progress={progress}
    />
  );
}
