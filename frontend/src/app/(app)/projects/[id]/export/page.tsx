import { createSupabaseServer } from "@/lib/supabase/server";
import { ExportPage } from "@/components/export/ExportPage";

export default async function ExportPageRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("name, pydantic_fields")
    .eq("id", id)
    .single();

  const fields = (project?.pydantic_fields || []) as {
    name: string;
    description: string;
  }[];

  // Get responses + review count in parallel
  const [{ data: responses }, { count: reviewCount }] = await Promise.all([
    supabase
      .from("responses")
      .select("document_id, respondent_name, respondent_type, answers, documents(external_id, title)")
      .eq("project_id", id)
      .eq("is_current", true),
    supabase
      .from("reviews")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id),
  ]);

  // Build CSV
  const headers = [
    "document_id",
    "document_title",
    "respondent",
    "type",
    ...fields.map((f) => f.name),
  ];
  const rows = (responses || []).map((r) => {
    const doc = (r.documents as unknown as { external_id: string | null; title: string | null } | null);
    return [
      doc?.external_id || r.document_id,
      doc?.title || "",
      r.respondent_name || "",
      r.respondent_type,
      ...fields.map((f) => {
        const val = r.answers?.[f.name];
        return Array.isArray(val) ? val.join("; ") : String(val || "");
      }),
    ].join(",");
  });
  const csvData = [headers.join(","), ...rows].join("\n");

  // Build Markdown report
  const markdownReport = `# Relatório — ${project?.name || "Projeto"}

## Resumo
- **Total de respostas:** ${responses?.length || 0}
- **Total de revisões:** ${reviewCount || 0}

## Campos
${fields.map((f) => `- **${f.name}**: ${f.description}`).join("\n")}
`;

  return (
    <ExportPage
      projectId={id}
      csvData={csvData}
      markdownReport={markdownReport}
    />
  );
}
