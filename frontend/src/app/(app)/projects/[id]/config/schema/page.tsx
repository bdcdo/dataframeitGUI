import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { SchemaEditorSession } from "@/components/schema/SchemaEditor";
import type { PydanticField } from "@/lib/types";
import { deriveProjectVersionContext, formatVersion } from "@/lib/compare-version";

export default async function SchemaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    getAuthUser(),
    createSupabaseServer(),
  ]);
  if (!user) redirect("/auth/login");

  const { data: project } = await supabase
    .from("projects")
    .select(
      "pydantic_code, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, schema_revision",
    )
    .eq("id", id)
    .single();

  const version = formatVersion(deriveProjectVersionContext(project ?? {}).version);

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  return (
    <SchemaEditorSession
      projectId={id}
      userId={user.id}
      initialCode={project?.pydantic_code}
      initialFields={fields}
      currentVersion={version}
      currentRevision={project?.schema_revision ?? 0}
    />
  );
}
