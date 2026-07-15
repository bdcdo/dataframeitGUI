"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isLlmEnabled } from "@/lib/feature-flags";
import {
  getDefaultAutomationMode,
  isAutomationMode,
  isAutomationModeAvailable,
  type AutomationMode,
} from "@/lib/automation-modes";

const LLM_CONFIGURATION_DISABLED_ERROR =
  "As configurações de LLM estão desabilitadas neste ambiente.";

export async function createProject(_prev: unknown, formData: FormData) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const name = formData.get("name") as string;
  const description = formData.get("description") as string;
  const llmEnabled = isLlmEnabled();
  const rawMode = formData.get("automation_mode");
  const rawComparisonIncludesLlm = formData.get("comparison_includes_llm");
  if (
    !llmEnabled &&
    ((isAutomationMode(rawMode) &&
      !isAutomationModeAvailable(rawMode, llmEnabled)) ||
      rawComparisonIncludesLlm === "true")
  ) {
    return { error: LLM_CONFIGURATION_DISABLED_ERROR };
  }
  const automationMode = isAutomationMode(rawMode)
    ? rawMode
    : getDefaultAutomationMode(llmEnabled);
  const projectData = {
    name,
    description,
    created_by: user.id,
    automation_mode: automationMode,
    // O default histórico do banco é true. No alfa sem LLM precisamos gravar
    // false explicitamente para que novos projetos não nasçam com uma
    // automação LLM latente; projetos existentes não são reescritos.
    ...(!llmEnabled && { comparison_includes_llm: false }),
  };
  const supabase = await createSupabaseServer();

  const { data: project, error } = await supabase
    .from("projects")
    .insert(projectData)
    .select()
    .single();

  if (error) return { error: error.message };

  // Add creator as coordinator
  const { error: memberError } = await supabase
    .from("project_members")
    .insert({
      project_id: project.id,
      user_id: user.id,
      role: "coordenador",
    });

  if (memberError) return { error: memberError.message };

  revalidatePath("/dashboard");
  redirect(`/projects/${project.id}/documents`);
}

// Retorno { error } em vez de throw: o Next mascara a message de erros
// lançados em Server Actions em produção (o client recebe mensagem genérica
// + digest), então a copy pt-BR só chega ao toast pelo retorno.
export async function updateProject(
  projectId: string,
  data: {
    name?: string;
    description?: string;
    resolution_rule?: string;
    min_responses_for_comparison?: number;
    allow_researcher_review?: boolean;
    arbitration_blind?: boolean;
    automation_mode?: AutomationMode;
    comparison_includes_llm?: boolean;
    out_of_scope_enabled?: boolean;
  }
): Promise<{ error?: string }> {
  const llmEnabled = isLlmEnabled();
  if (
    data.automation_mode !== undefined &&
    (!isAutomationMode(data.automation_mode) ||
      !isAutomationModeAvailable(data.automation_mode, llmEnabled))
  ) {
    return {
      error: !isAutomationMode(data.automation_mode)
        ? "Modo de automação inválido."
        : LLM_CONFIGURATION_DISABLED_ERROR,
    };
  }
  if (
    data.comparison_includes_llm !== undefined &&
    typeof data.comparison_includes_llm !== "boolean"
  ) {
    return { error: "Configuração de comparação LLM inválida." };
  }
  if (!llmEnabled && data.comparison_includes_llm === true) {
    return { error: LLM_CONFIGURATION_DISABLED_ERROR };
  }

  const supabase = await createSupabaseServer();
  try {
    await updateOrThrow(supabase, "projects", data, { id: projectId }, {
      message: "Sem permissão para alterar as configurações deste projeto.",
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro ao salvar o projeto" };
  }
  revalidatePath(`/projects/${projectId}`);
  return {};
}
