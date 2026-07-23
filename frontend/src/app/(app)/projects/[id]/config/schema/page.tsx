import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { SchemaEditorSession } from "@/components/schema/SchemaEditor";
import type { PydanticField } from "@/lib/types";

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

  const version = `${project?.schema_version_major ?? 0}.${project?.schema_version_minor ?? 1}.${project?.schema_version_patch ?? 0}`;

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
