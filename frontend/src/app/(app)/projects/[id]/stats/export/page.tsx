import { createSupabaseServer } from "@/lib/supabase/server";
import { ExportPanel } from "@/components/stats/ExportPanel";

export default async function ExportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const [{ data: project }, { data: responses }, { data: reviews }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("name, pydantic_fields")
        .eq("id", id)
        .single(),
      supabase
        .from("responses")
        .select(
          "id, document_id, respondent_name, respondent_type, answers, documents(external_id, title)",
        )
        .eq("project_id", id)
        .eq("is_current", true),
      supabase
        .from("reviews")
        .select("document_id, field_name, verdict, comment")
        .eq("project_id", id),
    ]);

  const fields = (project?.pydantic_fields || []) as {
    name: string;
    description: string;
    target?: string;
  }[];

  const exportableFields = fields.filter((f) => f.target !== "llm_only");

  // --- Dataset 1: Individual responses ---
  const individualHeaders = [
    "document_id",
    "document_title",
    "respondent",
    "respondent_type",
    "source",
    ...exportableFields.map((f) => f.name),
  ];

  const individualRows = (responses || []).map((r) => {
    const doc = r.documents as unknown as {
      external_id: string | null;
      title: string | null;
    } | null;
    const source = r.respondent_type === "llm" ? "llm" : "codificacao";
    return [
      doc?.external_id || r.document_id,
      doc?.title || "",
      r.respondent_name || "",
      r.respondent_type,
      source,
      ...exportableFields.map((f) => {
        const val = (r.answers as Record<string, unknown>)?.[f.name];
        return Array.isArray(val) ? val.join("; ") : String(val ?? "");
      }),
    ];
  });

  // --- Dataset 2: Reviewer verdicts (gabarito) ---
  // Group reviews by document_id, build one row per document
  const verdictsByDoc = new Map<
    string,
    { fields: Map<string, string>; comments: string[] }
  >();
  reviews?.forEach((r) => {
    if (!verdictsByDoc.has(r.document_id)) {
      verdictsByDoc.set(r.document_id, {
        fields: new Map(),
        comments: [],
      });
    }
    const entry = verdictsByDoc.get(r.document_id)!;

    let displayVerdict = r.verdict;
    if (r.verdict === "ambiguo") displayVerdict = "[AMBÍGUO]";
    else if (r.verdict === "pular") displayVerdict = "[PULAR]";
    else if (r.verdict.startsWith("{")) {
      try {
        const parsed = JSON.parse(r.verdict) as Record<string, boolean>;
        const selected = Object.entries(parsed)
          .filter(([, v]) => v)
          .map(([k]) => k);
        displayVerdict = selected.join("; ");
      } catch {
        /* keep raw */
      }
    }

    entry.fields.set(r.field_name, displayVerdict);
    if (r.comment) entry.comments.push(`[${r.field_name}] ${r.comment}`);
  });

  // Build doc title map from responses
  const docTitleMap = new Map<string, string>();
  responses?.forEach((r) => {
    const doc = r.documents as unknown as {
      external_id: string | null;
      title: string | null;
    } | null;
    if (!docTitleMap.has(r.document_id)) {
      docTitleMap.set(r.document_id, doc?.title || doc?.external_id || r.document_id);
    }
  });

  const verdictHeaders = [
    "document_id",
    "document_title",
    "source",
    ...exportableFields.map((f) => f.name),
    "reviewer_comments",
  ];

  const verdictRows = [...verdictsByDoc.entries()].map(
    ([docId, { fields: fieldMap, comments }]) => [
      docId,
      docTitleMap.get(docId) || docId,
      "comparacao",
      ...exportableFields.map((f) => fieldMap.get(f.name) || ""),
      comments.join(" | "),
    ],
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <ExportPanel
        projectId={id}
        projectName={project?.name || "Projeto"}
        individualHeaders={individualHeaders}
        individualRows={individualRows}
        verdictHeaders={verdictHeaders}
        verdictRows={verdictRows}
      />
    </div>
  );
}
