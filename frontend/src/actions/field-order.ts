"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";

export async function getResearcherFieldOrder(
  projectId: string,
): Promise<{ order: string[] | null; error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { order: null, error: actor.error };

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("researcher_field_orders")
    .select("field_order")
    .eq("project_id", projectId)
    .eq("user_id", actor.memberUserId)
    .maybeSingle();

  if (error) {
    console.error("[getResearcherFieldOrder]", error);
    return { order: null, error: error.message };
  }
  if (!data) return { order: null };

  const raw = data.field_order;
  if (!Array.isArray(raw)) return { order: null };
  const order = raw.filter((x): x is string => typeof x === "string");
  return { order };
}

export async function saveResearcherFieldOrder(
  projectId: string,
  fieldOrder: string[],
): Promise<{ success: boolean; error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { success: false, error: actor.error };

  if (!Array.isArray(fieldOrder) || !fieldOrder.every((x) => typeof x === "string")) {
    return { success: false, error: "Ordem inválida" };
  }

  const supabase = await createSupabaseServer();
  const { error } = await supabase.from("researcher_field_orders").upsert(
    {
      project_id: projectId,
      user_id: actor.memberUserId,
      field_order: fieldOrder,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,user_id" },
  );

  if (error) {
    console.error("[saveResearcherFieldOrder]", error);
    return { success: false, error: error.message };
  }
  return { success: true };
}
