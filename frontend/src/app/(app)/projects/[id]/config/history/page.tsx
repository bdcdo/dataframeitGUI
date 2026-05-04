import { createSupabaseServer } from "@/lib/supabase/server";
import { SchemaHistoryView } from "@/components/schema/SchemaHistoryView";
import type {
  PydanticField,
  SchemaChangeEntry,
  SchemaChangeType,
} from "@/lib/types";

export default async function SchemaHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const HISTORY_LIMIT = 200;

  const [{ data: project }, { data: changes }] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", id)
      .single(),
    supabase
      .from("schema_change_log")
      .select(
        "id, field_name, change_summary, before_value, after_value, created_at, change_type, version_major, version_minor, version_patch, changed_by, profiles(first_name, last_name, email)",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const fieldOptions = fields.map((f) => ({
    name: f.name,
    description: f.description || f.name,
  }));

  const entries: SchemaChangeEntry[] = (changes || []).map((c) => {
    const p = c.profiles as unknown as {
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    } | null;
    const fullName = [p?.first_name, p?.last_name].filter(Boolean).join(" ");
    const changedBy =
      fullName || p?.email?.split("@")[0] || "Anônimo";
    const major = c.version_major as number | null;
    const minor = c.version_minor as number | null;
    const patch = c.version_patch as number | null;
    const version =
      major !== null && minor !== null && patch !== null
        ? { major, minor, patch }
        : null;
    return {
      id: c.id as string,
      fieldName: c.field_name as string,
      changeSummary: (c.change_summary as string) ?? "",
      beforeValue: (c.before_value as Record<string, unknown>) ?? {},
      afterValue: (c.after_value as Record<string, unknown>) ?? {},
      changedBy,
      userId: (c.changed_by as string | null) ?? "",
      createdAt: c.created_at as string,
      changeType: (c.change_type as SchemaChangeType | null) ?? null,
      version,
    };
  });

  const truncated = entries.length >= HISTORY_LIMIT;

  return (
    <div className="flex h-[calc(100vh-148px)] flex-col">
      <SchemaHistoryView
        entries={entries}
        fieldOptions={fieldOptions}
        truncated={truncated}
        limit={HISTORY_LIMIT}
      />
    </div>
  );
}
