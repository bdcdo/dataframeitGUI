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

  // Phase 1: Get responses WITHOUT document text (lightweight)
  const { data: allResponses } = await supabase
    .from("responses")
    .select("id, document_id, respondent_type, respondent_name, answers, justifications, is_current, documents(id, title, external_id)")
    .eq("project_id", id);

  // Group responses by document
  const responsesByDoc = new Map<string, CompareResponse[]>();
  const docsMetaMap = new Map<string, Omit<CompareDoc, "text">>();

  allResponses?.forEach((r) => {
    const docId = r.document_id;
    if (!responsesByDoc.has(docId)) responsesByDoc.set(docId, []);
    responsesByDoc.get(docId)!.push(r as unknown as CompareResponse);
    if (r.documents) docsMetaMap.set(docId, r.documents as unknown as Omit<CompareDoc, "text">);
  });

  // Find divergent fields per document
  const divergentFields: Record<string, string[]> = {};
  const responsesMap: Record<string, CompareResponse[]> = {};
  const divergentDocIds: string[] = [];

  for (const [docId, docResponses] of responsesByDoc) {
    if (docResponses.length < minResponses) continue;

    const activeResponses = docResponses.filter(
      (r) => r.is_current || r.respondent_type === "humano"
    );

    const divergent: string[] = [];
    for (const field of fields) {
      if (field.target === "llm_only" || field.target === "human_only") continue;
      const answers = activeResponses.map((r) => r.answers?.[field.name]);
      const uniqueAnswers = new Set(answers.map((a) => JSON.stringify(a)));
      if (uniqueAnswers.size > 1) {
        divergent.push(field.name);
      }
    }

    if (divergent.length > 0 && docsMetaMap.has(docId)) {
      divergentDocIds.push(docId);
      divergentFields[docId] = divergent;
      responsesMap[docId] = activeResponses;
    }
  }

  // Phase 2: Fetch text ONLY for divergent documents + reviews in parallel
  const [{ data: docTexts }, { data: reviews }] = await Promise.all([
    divergentDocIds.length > 0
      ? supabase
          .from("documents")
          .select("id, text")
          .in("id", divergentDocIds)
      : Promise.resolve({ data: [] as { id: string; text: string }[] }),
    supabase
      .from("reviews")
      .select("document_id, field_name, verdict")
      .eq("project_id", id),
  ]);

  const textMap = new Map((docTexts || []).map((d) => [d.id, d.text]));

  const documentsForCompare: CompareDoc[] = divergentDocIds
    .map((docId) => {
      const meta = docsMetaMap.get(docId)!;
      return { ...meta, text: textMap.get(docId) || "" };
    });

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
