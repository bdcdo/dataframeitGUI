import type { SupabaseClient } from "@supabase/supabase-js";
import { serverErrorCopy } from "@/lib/server-error";
import { errorMessage } from "@/lib/utils";

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
// Next mascara a message em produção. A action captura e retorna { error }.

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

// Erro real do PostgREST no write. Carrega o `code` do Postgres (57014 timeout,
// 23505 unique, ...) para o log da action distinguir as causas: um
// `new Error(error.message)` o descartava e o log saía com `code: undefined`.
export class PostgrestWriteError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PostgrestWriteError";
  }
}

// Copy do toast para o que updateOrThrow/deleteOrThrow lançam: ZeroRowsError já
// traz a copy de permissão do fluxo; o resto (PostgrestWriteError, falha de rede)
// vai para o log com o `code`, e o toast recebe a copy genérica (#502).
export function guardErrorCopy(e: unknown, scope: string, generic: string): string {
  if (e instanceof ZeroRowsError) return e.message;
  const code = e instanceof PostgrestWriteError ? e.code : undefined;
  return serverErrorCopy(scope, { code, message: errorMessage(e) }, { generic });
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
  if (error) throw new PostgrestWriteError(error.message, error.code);
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
  if (error) throw new PostgrestWriteError(error.message, error.code);
  if (!data || data.length === 0) {
    throw new ZeroRowsError(table, "delete", opts?.message);
  }
  return data as unknown as Array<Record<string, unknown>>;
}
