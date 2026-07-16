"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { RoundStrategy } from "@/lib/types";

// Postgres unique_violation. Tabela `rounds` tem UNIQUE(project_id, label) —
// sem mapeamento, o usuario veria o erro cru "duplicate key value violates...".
const PG_UNIQUE_VIOLATION = "23505";

function mapRoundsError(err: { code?: string; message: string }): string {
  if (err.code === PG_UNIQUE_VIOLATION) {
    return "Já existe uma rodada com esse nome neste projeto.";
  }
  return err.message;
}

async function assertCoordinator(
  projectId: string,
): Promise<{ error?: string }> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem alterar rodadas.",
  );
  return gate.ok ? {} : { error: gate.error };
}

export async function createRound(
  projectId: string,
  label: string,
  setAsCurrent: boolean = false,
): Promise<{ error?: string; id?: string }> {
  const trimmed = label.trim();
  if (!trimmed) return { error: "Nome da rodada é obrigatório." };

  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("rounds")
    .insert({ project_id: projectId, label: trimmed })
    .select("id")
    .single();
  if (error) return { error: mapRoundsError(error) };

  if (setAsCurrent && data?.id) {
    // Nao-transacional: se este update falhar, a rodada ja foi criada e o
    // coordenador precisa marca-la como atual manualmente em /config/rounds.
    // Uma RPC com transacao seria overkill para a baixa frequencia da operacao.
    // O id volta junto com o erro para a UI refletir o estado parcial.
    const { data: updated, error: updErr } = await supabase
      .from("projects")
      .update({ current_round_id: data.id })
      .eq("id", projectId)
      .select("id");
    if (updErr) return { id: data.id, error: updErr.message };
    if (!updated || updated.length === 0) {
      return {
        id: data.id,
        error:
          "Rodada criada, mas não foi possível defini-la como atual (sem permissão). Selecione-a manualmente em Configurações → Rodadas.",
      };
    }
  }

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return { id: data?.id };
}

export async function renameRound(
  projectId: string,
  roundId: string,
  label: string,
): Promise<{ error?: string }> {
  const trimmed = label.trim();
  if (!trimmed) return { error: "Nome da rodada é obrigatório." };

  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("rounds")
    .update({ label: trimmed })
    .eq("id", roundId)
    .eq("project_id", projectId)
    .select("id");
  if (error) return { error: mapRoundsError(error) };
  if (!data || data.length === 0) {
    return { error: "Sem permissão para renomear esta rodada (ou ela não existe)." };
  }

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}

export async function setCurrentRound(
  projectId: string,
  roundId: string | null,
): Promise<{ error?: string }> {
  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();

  // Validar cross-project: a FK garante que round_id existe em rounds, mas
  // nao que pertence ao project_id correto. Sem essa checagem, um coordenador
  // de dois projetos poderia apontar A.current_round_id para uma rodada de B.
  if (roundId) {
    const { data: round } = await supabase
      .from("rounds")
      .select("id")
      .eq("id", roundId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (!round) return { error: "Rodada inválida para este projeto." };
  }

  const { data, error } = await supabase
    .from("projects")
    .update({ current_round_id: roundId })
    .eq("id", projectId)
    .select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) {
    return { error: "Sem permissão para alterar a rodada atual deste projeto." };
  }

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}

export async function deleteRound(
  projectId: string,
  roundId: string,
): Promise<{ error?: string }> {
  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("rounds")
    .delete()
    .eq("id", roundId)
    .eq("project_id", projectId)
    .select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) {
    return { error: "Sem permissão para excluir esta rodada (ou ela não existe)." };
  }

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}

export async function setRoundStrategy(
  projectId: string,
  strategy: RoundStrategy,
): Promise<{ error?: string }> {
  // Server actions recebem dados arbitrarios do cliente; o tipo TS protege so
  // em compile-time. CHECK constraint do DB barra, mas mensagem fica feia.
  if (strategy !== "schema_version" && strategy !== "manual") {
    return { error: "Estratégia inválida." };
  }

  // Nota: nao limpamos current_round_id ao mudar para schema_version. Isso
  // preserva a config caso o coordenador volte para manual depois. Leituras
  // (page.tsx, saveResponse) ignoram current_round_id quando strategy nao e
  // 'manual', entao manter o valor stale e seguro.

  const auth = await assertCoordinator(projectId);
  if (auth.error) return { error: auth.error };

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("projects")
    .update({ round_strategy: strategy })
    .eq("id", projectId)
    .select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) {
    return { error: "Sem permissão para alterar a estratégia de rodadas deste projeto." };
  }

  revalidatePath(`/projects/${projectId}/config/rounds`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return {};
}
