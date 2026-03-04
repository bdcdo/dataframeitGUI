import { createSupabaseServer } from "@/lib/supabase/server";
import { PydanticEditor } from "@/components/schema/PydanticEditor";
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
    <PydanticEditor
      projectId={id}
      initialCode={project?.pydantic_code}
      initialFields={(project?.pydantic_fields || []) as PydanticField[]}
    />
  );
}
