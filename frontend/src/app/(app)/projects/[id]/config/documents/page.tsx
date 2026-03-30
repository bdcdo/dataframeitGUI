import { createSupabaseServer } from "@/lib/supabase/server";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { DocumentsPageClient } from "@/components/documents/DocumentsPageClient";

export default async function ConfigDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: documents } = await supabase
    .from("documents")
    .select("id, external_id, title, created_at, responses(count)")
    .eq("project_id", id)
    .order("created_at", { ascending: true });

  const docsWithCounts = (documents || []).map((d) => ({
    id: d.id,
    external_id: d.external_id,
    title: d.title,
    created_at: d.created_at,
    responseCount:
      (d.responses as unknown as { count: number }[])?.[0]?.count || 0,
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <DocumentUpload projectId={id} />
      <DocumentsPageClient documents={docsWithCounts} projectId={id} />
    </div>
  );
}
