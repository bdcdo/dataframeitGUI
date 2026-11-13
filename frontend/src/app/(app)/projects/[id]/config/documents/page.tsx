import { createSupabaseServer } from "@/lib/supabase/server";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { DocumentsPageClient } from "@/components/documents/DocumentsPageClient";
import { ExportCard } from "@/components/documents/ExportCard";
import { AutoReviewVerdictsExportCard } from "@/components/documents/AutoReviewVerdictsExportCard";
import { usesAutoReviewSource } from "@/lib/llm-error-metrics";

export default async function ConfigDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const [{ id }, { show }, supabase] = await Promise.all([
    params,
    searchParams,
    createSupabaseServer(),
  ]);
  const showExcluded = show === "excluded";

  let query = supabase
    .from("documents")
    .select(
      "id, external_id, title, created_at, excluded_at, excluded_reason, excluded_by, exclusion_pending_at, responses(count)",
    )
    .eq("project_id", id);

  query = showExcluded
    ? query.not("excluded_at", "is", null)
    : query.is("excluded_at", null);

  // O modo decide se o card dos vereditos da auto-revisão aparece.
  const [{ data: documents }, { data: project }] = await Promise.all([
    query.order("created_at", { ascending: true }),
    supabase.from("projects").select("automation_mode").eq("id", id).single(),
  ]);
  const showAutoReviewExport = usesAutoReviewSource(project?.automation_mode ?? null);

  // Resolve excluded_by ids para nomes (so quando mostrando excluidos)
  const excludedByIds = showExcluded
    ? Array.from(
        new Set(
          (documents || []).flatMap((d) =>
            d.excluded_by ? [d.excluded_by] : [],
          ),
        ),
      )
    : [];

  const profileById = new Map<string, string>();
  if (excludedByIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, first_name, email")
      .in("id", excludedByIds);
    for (const p of profiles || []) {
      profileById.set(p.id, p.first_name || p.email || p.id);
    }
  }

  const docsWithCounts = (documents || []).map((d) => ({
    id: d.id,
    external_id: d.external_id,
    title: d.title,
    created_at: d.created_at,
    excluded_at: d.excluded_at,
    excluded_reason: d.excluded_reason,
    excluded_by: d.excluded_by,
    excluded_by_name: d.excluded_by ? profileById.get(d.excluded_by) || null : null,
    exclusion_pending_at: d.exclusion_pending_at,
    responseCount:
      (d.responses as unknown as { count: number }[])?.[0]?.count || 0,
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <DocumentUpload projectId={id} />
      <ExportCard projectId={id} />
      {showAutoReviewExport && <AutoReviewVerdictsExportCard projectId={id} />}
      <DocumentsPageClient
        documents={docsWithCounts}
        projectId={id}
        showExcluded={showExcluded}
      />
    </div>
  );
}
