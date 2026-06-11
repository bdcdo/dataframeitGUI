import type { SupabaseClient } from "@supabase/supabase-js";

// UPDATE/DELETE via client RLS que não casa nenhuma linha (porque a policy
// filtrou, ou porque o registro não existe) retorna sucesso com 0 linhas e
// error=null no PostgREST — sem este guard a falha é invisível e a UI mostra
// sucesso falso (issue #178: coordenador não-criador "salvava" o schema sem
// persistir nada). Todo UPDATE/DELETE de Server Action via createSupabaseServer
// deve passar por aqui ou checar 0-rows manualmente.

export class ZeroRowsError extends Error {
  constructor(
    public readonly table: string,
    public readonly operation: "update" | "delete",
    message?: string,
  ) {
    super(
      message ??
        `Nenhuma linha alterada em ${table}: sem permissão (RLS) ou registro inexistente.`,
    );
    this.name = "ZeroRowsError";
  }
}

interface GuardOpts {
  // Copy pt-BR específica do fluxo — vai para o toast do usuário.
  message?: string;
  // Para tabelas sem coluna `id`.
  selectColumn?: string;
}

export async function updateOrThrow(
  supabase: SupabaseClient,
  table: string,
  payload: Record<string, unknown>,
  match: Record<string, unknown>,
  opts?: GuardOpts,
): Promise<Array<Record<string, unknown>>> {
  const col = opts?.selectColumn ?? "id";
  const { data, error } = await supabase
    .from(table)
    .update(payload)
    .match(match)
    .select(col);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new ZeroRowsError(table, "update", opts?.message);
  }
  // `col` dinâmico faz o supabase-js tipar data como GenericStringError[].
  return data as unknown as Array<Record<string, unknown>>;
}

export async function deleteOrThrow(
  supabase: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  opts?: GuardOpts,
): Promise<Array<Record<string, unknown>>> {
  const col = opts?.selectColumn ?? "id";
  const { data, error } = await supabase
    .from(table)
    .delete()
    .match(match)
    .select(col);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new ZeroRowsError(table, "delete", opts?.message);
  }
  return data as unknown as Array<Record<string, unknown>>;
}
