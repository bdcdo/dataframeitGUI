import type { SupabaseClient } from "@supabase/supabase-js";
import { UserFacingError, type ServerError } from "@/lib/server-error";

// UPDATE/DELETE via client RLS que não casa nenhuma linha (porque a policy
// filtrou, ou porque o registro não existe) retorna sucesso com 0 linhas e
// error=null no PostgREST — sem este guard a falha é invisível e a UI mostra
// sucesso falso (issue #178: coordenador não-criador "salvava" o schema sem
// persistir nada). Todo UPDATE/DELETE de Server Action via createSupabaseServer
// deve passar por aqui ou checar 0-rows manualmente.
//
// Pressuposto: o .select() pós-write usa RETURNING, que no Postgres exige que
// a linha afetada seja visível pela policy de SELECT. Se uma tabela tiver
// policy de UPDATE/DELETE mais permissiva que a de SELECT, o guard reporta
// falha falsa após uma escrita bem-sucedida — alinhar as policies antes de
// usar o guard nessa tabela.
//
// Os throws daqui não devem atravessar a fronteira de uma Server Action: o
// Next mascara a message em produção. A action captura e retorna { error },
// com `caughtErrorCopy`: o ZeroRowsError já traz a copy de permissão do fluxo,
// e o resto vai para o log com o `code` (#502).

export class ZeroRowsError extends UserFacingError {
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

// Erro real do PostgREST, na escrita ou na leitura dentro de um `try`. Carrega
// o `code` do Postgres (57014 timeout, 23505 unique, ...), o `details` e o
// `hint` para o log da action distinguir as causas (`caughtErrorCopy`): um
// `new Error(error.message)` os descartava e o log saía com `code: undefined`.
export class PostgrestWriteError extends Error {
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  /** `context`, quando dado, prefixa a mensagem: "Erro ao ler X: <texto>". */
  constructor(error: ServerError, context?: string) {
    super(context ? `${context}: ${error.message}` : error.message);
    this.name = "PostgrestWriteError";
    this.code = error.code;
    this.details = error.details ?? undefined;
    this.hint = error.hint ?? undefined;
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
  if (error) throw new PostgrestWriteError(error);
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
  if (error) throw new PostgrestWriteError(error);
  if (!data || data.length === 0) {
    throw new ZeroRowsError(table, "delete", opts?.message);
  }
  return data as unknown as Array<Record<string, unknown>>;
}
