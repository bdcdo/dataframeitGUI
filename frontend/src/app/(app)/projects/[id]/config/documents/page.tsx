import { createSupabaseServer } from "@/lib/supabase/server";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { DocumentsPageClient } from "@/components/documents/DocumentsPageClient";

export default async function ConfigDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { id } = await params;
  const { show } = await searchParams;
  const showExcluded = show === "excluded";
  const supabase = await createSupabaseServer();

  let query = supabase
    .from("documents")
    .select(
      "id, external_id, title, created_at, excluded_at, excluded_reason, excluded_by, responses(count)",
    )
    .eq("project_id", id);

  query = showExcluded
    ? query.not("excluded_at", "is", null)
    : query.is("excluded_at", null);

  const { data: documents } = await query.order("created_at", {
    ascending: true,
  });

  // Resolve excluded_by ids para nomes (so quando mostrando excluidos)
  const excludedByIds = showExcluded
    ? Array.from(
        new Set(
          (documents || [])
            .map((d) => d.excluded_by)
            .filter((v): v is string => !!v),
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
    responseCount:
      (d.responses as unknown as { count: number }[])?.[0]?.count || 0,
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <DocumentUpload projectId={id} />
      <DocumentsPageClient
        documents={docsWithCounts}
        projectId={id}
        showExcluded={showExcluded}
      />
    </div>
  );
}
