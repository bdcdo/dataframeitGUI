import { createSupabaseServer } from "@/lib/supabase/server";
import { ExportPanel } from "@/components/stats/ExportPanel";
import { normalizeForComparison } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";

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
        .select("name, pydantic_fields, min_responses_for_comparison")
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

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const minResponses = project?.min_responses_for_comparison || 2;

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
    if (r.verdict === "ambiguo") displayVerdict = "[AMBIGUO]";
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

  // --- Build agreement map: auto-fill concordant fields ---
  const agreementByDoc = new Map<string, Map<string, string>>();
  const responsesByDoc = new Map<string, NonNullable<typeof responses>>();
  responses?.forEach((r) => {
    if (!responsesByDoc.has(r.document_id))
      responsesByDoc.set(r.document_id, []);
    responsesByDoc.get(r.document_id)!.push(r);
  });

  for (const [docId, docResponses] of responsesByDoc) {
    if (docResponses.length < minResponses) continue;

    const fieldAgreements = new Map<string, string>();

    for (const field of exportableFields) {
      if (verdictsByDoc.get(docId)?.fields.has(field.name)) continue;

      const fullField = fields.find((f) => f.name === field.name);

      if (fullField?.type === "multi" && fullField.options?.length) {
        const comparableOptions = new Set(fullField.options);
        for (const r of docResponses) {
          const arr = (r.answers as Record<string, unknown>)?.[field.name];
          if (Array.isArray(arr)) {
            for (const v of arr) {
              if (typeof v === "string") comparableOptions.add(v);
            }
          }
        }
        let hasDivergence = false;
        for (const opt of comparableOptions) {
          const selections = docResponses.map((r) => {
            const arr = (r.answers as Record<string, unknown>)?.[field.name];
            return Array.isArray(arr) && arr.includes(opt);
          });
          if (!selections.every((s) => s === selections[0])) {
            hasDivergence = true;
            break;
          }
        }
        if (!hasDivergence) {
          const val = (docResponses[0].answers as Record<string, unknown>)?.[
            field.name
          ];
          fieldAgreements.set(
            field.name,
            Array.isArray(val) ? val.join("; ") : String(val ?? ""),
          );
        }
      } else {
        const answers = docResponses.map(
          (r) => (r.answers as Record<string, unknown>)?.[field.name],
        );
        const uniqueAnswers = new Set(
          answers.map((a) => normalizeForComparison(a)),
        );
        if (uniqueAnswers.size === 1) {
          const val = answers[0];
          fieldAgreements.set(
            field.name,
            Array.isArray(val) ? val.join("; ") : String(val ?? ""),
          );
        }
      }
    }

    if (fieldAgreements.size > 0) {
      agreementByDoc.set(docId, fieldAgreements);
    }
  }

  // Build doc title map from responses
  const docTitleMap = new Map<string, string>();
  responses?.forEach((r) => {
    const doc = r.documents as unknown as {
      external_id: string | null;
      title: string | null;
    } | null;
    if (!docTitleMap.has(r.document_id)) {
      docTitleMap.set(
        r.document_id,
        doc?.title || doc?.external_id || r.document_id,
      );
    }
  });

  const verdictHeaders = [
    "document_id",
    "document_title",
    "source",
    ...exportableFields.map((f) => f.name),
    "reviewer_comments",
  ];

  // Merge reviews + agreement: all qualifying documents
  const allGabaritoDocIds = new Set<string>([
    ...verdictsByDoc.keys(),
    ...agreementByDoc.keys(),
  ]);

  const verdictRows = [...allGabaritoDocIds].map((docId) => {
    const reviewEntry = verdictsByDoc.get(docId);
    const agreementEntry = agreementByDoc.get(docId);
    const comments = reviewEntry?.comments || [];

    return [
      docId,
      docTitleMap.get(docId) || docId,
      "comparacao",
      ...exportableFields.map((f) => {
        const reviewValue = reviewEntry?.fields.get(f.name);
        if (reviewValue !== undefined) return reviewValue;
        const agreementValue = agreementEntry?.get(f.name);
        if (agreementValue !== undefined) return agreementValue;
        return "";
      }),
      comments.join(" | "),
    ];
  });

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
