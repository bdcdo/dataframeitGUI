import { createSupabaseServer } from "@/lib/supabase/server";
import { CodingPage } from "@/components/coding/CodingPage";
import type { Document, Assignment } from "@/lib/types";

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

  const existingAnswers: Record<string, Record<string, unknown>> = {};
  responses?.forEach((r) => {
    existingAnswers[r.document_id] = r.answers as Record<string, unknown>;
  });

  return (
    <CodingPage
      projectId={id}
      documents={documents}
      fields={project?.pydantic_fields || []}
      existingAnswers={existingAnswers}
      hasAssignments={documents.length > 0}
    />
  );
}
