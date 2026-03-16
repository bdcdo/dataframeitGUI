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
    .select("pydantic_code, pydantic_fields")
    .eq("id", id)
    .single();

  return (
    <SchemaEditor
      projectId={id}
      initialCode={project?.pydantic_code}
      initialFields={(project?.pydantic_fields || []) as PydanticField[]}
    />
  );
}
