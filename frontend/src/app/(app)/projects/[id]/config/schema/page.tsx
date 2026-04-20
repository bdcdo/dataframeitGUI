import { createSupabaseServer } from "@/lib/supabase/server";
import { SchemaEditor } from "@/components/schema/SchemaEditor";
import type { PydanticField } from "@/lib/types";

export default async function SchemaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select(
      "pydantic_code, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("id", id)
    .single();

  const version = `${project?.schema_version_major ?? 0}.${project?.schema_version_minor ?? 1}.${project?.schema_version_patch ?? 0}`;

  return (
    <SchemaEditor
      projectId={id}
      initialCode={project?.pydantic_code}
      initialFields={(project?.pydantic_fields || []) as PydanticField[]}
      currentVersion={version}
    />
  );
}
