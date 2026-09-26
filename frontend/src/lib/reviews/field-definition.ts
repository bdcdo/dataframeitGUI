import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { PydanticField } from "@/lib/types";

/**
 * A definição atual de um campo no schema do projeto, ou `undefined` quando o
 * campo não está nele. As actions que gravam veredito a leem para conferir o
 * domínio do voto antes da escrita (`copiedVerdictInDomain`).
 */
export async function fetchFieldDefinition(
  supabase: SupabaseServerClient,
  projectId: string,
  fieldName: string,
): Promise<PydanticField | undefined> {
  const { data: project } = await supabase
    .from("projects").select("pydantic_fields").eq("id", projectId).single();
  return ((project?.pydantic_fields ?? []) as PydanticField[]).find((f) => f.name === fieldName);
}
