import { createSupabaseServer } from "@/lib/supabase/server";
import { ComparePage } from "@/components/compare/ComparePage";
import type { PydanticField } from "@/lib/types";

interface CompareDoc {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

interface CompareResponse {
  id: string;
  document_id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  is_current: boolean;
}

export default async function ComparePageRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_fields, min_responses_for_comparison")
    .eq("id", id)
    .single();

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const minResponses = project?.min_responses_for_comparison || 2;

  // Get all documents with responses
  const { data: allResponses } = await supabase
    .from("responses")
    .select("*, documents(id, title, external_id, text)")
    .eq("project_id", id);

  // Group responses by document
  const responsesByDoc = new Map<string, CompareResponse[]>();
  const docsMap = new Map<string, CompareDoc>();

  allResponses?.forEach((r) => {
    const docId = r.document_id;
    if (!responsesByDoc.has(docId)) responsesByDoc.set(docId, []);
    responsesByDoc.get(docId)!.push(r as unknown as CompareResponse);
    if (r.documents) docsMap.set(docId, r.documents as unknown as CompareDoc);
  });

  // Find divergent fields per document
  const divergentFields: Record<string, string[]> = {};
  const responsesMap: Record<string, CompareResponse[]> = {};
  const documentsForCompare: CompareDoc[] = [];

  for (const [docId, docResponses] of responsesByDoc) {
    if (docResponses.length < minResponses) continue;

    const activeResponses = docResponses.filter(
      (r) => r.is_current || r.respondent_type === "humano"
    );

    const divergent: string[] = [];
    for (const field of fields) {
      const answers = activeResponses.map((r) => r.answers?.[field.name]);
      const uniqueAnswers = new Set(answers.map((a) => JSON.stringify(a)));
      if (uniqueAnswers.size > 1) {
        divergent.push(field.name);
      }
    }

    if (divergent.length > 0) {
      const doc = docsMap.get(docId);
      if (doc) {
        documentsForCompare.push(doc);
        divergentFields[docId] = divergent;
        responsesMap[docId] = activeResponses;
      }
    }
  }

  // Get existing reviews
  const { data: reviews } = await supabase
    .from("reviews")
    .select("*")
    .eq("project_id", id);

  const existingReviews: Record<string, Record<string, string>> = {};
  reviews?.forEach((r) => {
    if (!existingReviews[r.document_id]) existingReviews[r.document_id] = {};
    existingReviews[r.document_id][r.field_name] = r.verdict;
  });

  return (
    <ComparePage
      projectId={id}
      documents={documentsForCompare}
      responses={responsesMap}
      divergentFields={divergentFields}
      fields={fields}
      existingReviews={existingReviews}
    />
  );
}
