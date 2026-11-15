// Erro de servidor numa Server Action (Postgres, PostgREST, backend): o texto
// é diagnóstico de desenvolvedor, em inglês, e não serve ao toast pt-BR, mas
// também não pode sumir. Vai para o log do servidor, e o toast recebe a copy
// do fluxo (#502).
//
// `byCode` mapeia os códigos que descrevem uma condição real que o usuário
// pode entender (registro já resolvido, sem permissão): esses ganham copy
// própria e não vão ao log, porque são estado esperado e não falha.
export interface ServerError {
  code?: string;
  message: string;
}

export interface ServerErrorCopy {
  generic: string;
  byCode?: Record<string, string>;
}

export function serverErrorCopy(
  scope: string,
  error: ServerError,
  copy: ServerErrorCopy,
): string {
  const specific = error.code ? copy.byCode?.[error.code] : undefined;
  if (specific) return specific;
  console.error(scope, { code: error.code, message: error.message });
  return copy.generic;
}
