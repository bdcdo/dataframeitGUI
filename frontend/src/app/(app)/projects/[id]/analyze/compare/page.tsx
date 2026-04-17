import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ComparePage } from "@/components/compare/ComparePage";
import { normalizeForComparison } from "@/lib/utils";
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
  pydantic_hash: string | null;
  answer_field_hashes: Record<string, string> | null;
}

export default async function ComparePageRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

  // Determine if user is coordinator
  const [{ data: project }, { data: membership }, { data: allResponses, error: responsesError }] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_hash, pydantic_fields, min_responses_for_comparison, created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("project_members")
      .select("role")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("responses")
      .select("id, document_id, respondent_type, respondent_name, answers, justifications, is_current, pydantic_hash, answer_field_hashes, documents(id, title, external_id)")
      .eq("project_id", id)
      .limit(5000),
  ]);

  const isCoordinator =
    membership?.role === "coordenador" || project?.created_by === user.id || user.isMaster;

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const minResponses = project?.min_responses_for_comparison || 2;

  if (responsesError) {
    console.error("Failed to fetch responses for compare:", responsesError.message);
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Erro ao carregar respostas. Tente novamente.
      </div>
    );
  }

  // For researchers, fetch their comparison assignments to filter docs.
  // Sem atribuições, o Set fica vazio e filtra tudo — pesquisador só vê o que lhe foi atribuído.
  let assignedDocIds: Set<string> | null = null;
  if (!isCoordinator) {
    const { data: comparisonAssignments } = await supabase
      .from("assignments")
      .select("document_id")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .eq("type", "comparacao");

    assignedDocIds = new Set(
      (comparisonAssignments ?? []).map((a) => a.document_id),
    );
  }

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
    // For researchers with comparison assignments, only show assigned docs
    if (assignedDocIds && !assignedDocIds.has(docId)) continue;

    if (docResponses.length < minResponses) continue;

    const activeResponses = docResponses.filter(
      (r) => r.is_current || r.respondent_type === "humano"
    );

    const divergent: string[] = [];
    for (const field of fields) {
      if (field.target === "llm_only" || field.target === "human_only") continue;

      if (field.type === "multi" && field.options?.length) {
        const comparableOptions = new Set(field.options);
        for (const r of activeResponses) {
          const arr = r.answers?.[field.name];
          if (Array.isArray(arr)) {
            for (const v of arr) {
              if (typeof v === "string") comparableOptions.add(v);
            }
          }
        }
        let hasDivergence = false;
        for (const opt of comparableOptions) {
          const selections = activeResponses.map((r) => {
            const arr = r.answers?.[field.name];
            return Array.isArray(arr) && arr.includes(opt);
          });
          if (!selections.every((s) => s === selections[0])) {
            hasDivergence = true;
            break;
          }
        }
        if (hasDivergence) divergent.push(field.name);
      } else {
        const answers = activeResponses.map((r) => r.answers?.[field.name]);
        const uniqueAnswers = new Set(answers.map((a) => normalizeForComparison(a)));
        if (uniqueAnswers.size > 1) {
          divergent.push(field.name);
        }
      }
    }

    if (divergent.length > 0 && docsMetaMap.has(docId)) {
      divergentDocIds.push(docId);
      divergentFields[docId] = divergent;
      responsesMap[docId] = docResponses;
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
      .select("document_id, field_name, verdict, chosen_response_id, comment")
      .eq("project_id", id),
  ]);

  const textMap = new Map((docTexts || []).map((d) => [d.id, d.text]));

  const documentsForCompare: CompareDoc[] = divergentDocIds
    .map((docId) => {
      const meta = docsMetaMap.get(docId)!;
      return { ...meta, text: textMap.get(docId) || "" };
    });

  const existingReviews: Record<string, Record<string, { verdict: string; chosenResponseId: string | null; comment: string | null }>> = {};
  reviews?.forEach((r) => {
    if (!existingReviews[r.document_id]) existingReviews[r.document_id] = {};
    existingReviews[r.document_id][r.field_name] = {
      verdict: r.verdict,
      chosenResponseId: r.chosen_response_id ?? null,
      comment: r.comment ?? null,
    };
  });

  // Extract unique respondent names for filter
  const respondentNames = [
    ...new Set(
      allResponses?.map((r) => r.respondent_name).filter(Boolean) ?? []
    ),
  ] as string[];

  return (
    <ComparePage
      projectId={id}
      documents={documentsForCompare}
      responses={responsesMap}
      divergentFields={divergentFields}
      fields={fields}
      existingReviews={existingReviews}
      projectPydanticHash={project?.pydantic_hash ?? null}
      respondentNames={respondentNames}
    />
  );
}
