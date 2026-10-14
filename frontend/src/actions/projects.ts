"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AUTOMATION_MODES, type AutomationMode } from "@/lib/types";

// Valores aceitos derivados da fonte única dos modos, para que um modo novo em
// AUTOMATION_MODES valha nas actions sem segunda edição. Não é exportado: num
// arquivo "use server" toda exportação vira endpoint, e a regra de lint
// async-value-exports só admite funções async.
const AUTOMATION_MODE_VALUES: ReadonlyArray<AutomationMode> = Object.freeze(
  AUTOMATION_MODES.map((m) => m.value),
);

export async function createProject(_prev: unknown, formData: FormData) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const name = formData.get("name") as string;
  const description = formData.get("description") as string;
  const rawMode = formData.get("automation_mode") as string | null;
  // Sem escolha explícita (campo ausente ou valor desconhecido), o projeto
  // nasce sem automação: ligar revisão automática é decisão do coordenador.
  // Os DEFAULTs da coluna e da RPC continuam 'auto_review_llm' por causa do
  // backfill histórico; por isso o valor vai sempre explícito na chamada.
  const automation_mode: AutomationMode = AUTOMATION_MODE_VALUES.includes(
    rawMode as AutomationMode,
  )
    ? (rawMode as AutomationMode)
    : "none";

  const { data: projectId, error } = await supabase.rpc(
    "create_project_with_initial_round",
    {
      p_name: name,
      p_description: description || null,
      p_automation_mode: automation_mode,
    },
  );

  if (error) return { error: error.message };
  if (!projectId) return { error: "Não foi possível criar o projeto." };

  revalidatePath("/dashboard");
  redirect(`/projects/${projectId}/documents`);
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
  // O tipo de `data` não vale em runtime: a Server Action recebe o que o
  // cliente enviar. O CHECK da coluna também recusaria um modo desconhecido,
  // mas com a mensagem crua do Postgres no toast.
  if (
    data.automation_mode !== undefined &&
    !AUTOMATION_MODE_VALUES.includes(data.automation_mode)
  ) {
    return { error: "Modo de automação inválido." };
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
