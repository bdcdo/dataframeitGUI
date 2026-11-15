import { errorMessage } from "@/lib/utils";

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

// Exceção não tratada no servidor (Server Action, render de RSC): em produção
// o Next 16 troca a `message` por um texto genérico em inglês e só deixa
// passar o `digest`, um hash de `message + stack` que é o mesmo no cliente e no
// `onRequestError` do servidor (#362, #653). O código abaixo é esse digest em
// base 36 — 6 ou 7 caracteres, curto para a usuária ditar — e
// `src/instrumentation.ts` loga o stack numa linha só com o mesmo código, de
// modo que `fly logs | grep <código>` entrega a exceção. Por ser hash, o mesmo
// erro no mesmo ponto repete o código: o grep traz também a frequência, e o
// horário de cada ocorrência vem do próprio log.
//
// Digest não numérico é de erro de controle do Next (`NEXT_REDIRECT`,
// `NEXT_HTTP_ERROR_FALLBACK;404`, `DYNAMIC_SERVER_USAGE`), não de falha.
export function errorCode(error: unknown): string | null {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? error.digest
      : undefined;
  if (typeof digest !== "string" || !/^\d+$/.test(digest)) return null;
  return Number(digest).toString(36).padStart(6, "0");
}

// Mensagem do toast para o `catch` de uma Server Action no cliente: exceção do
// servidor vira a copy pt-BR do fluxo com o código; erro do próprio cliente
// mantém a mensagem, como antes.
export function actionErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code) return `${fallback} — código ${code}`;
  return errorMessage(error) || fallback;
}

// Detalhe que as telas de erro (`error.tsx`, `global-error.tsx`) mostram: o
// código, quando o erro veio do servidor, ou a mensagem, quando o erro é do
// próprio navegador e não foi mascarado.
export function errorDetail(error: unknown): string | null {
  const code = errorCode(error);
  if (code) return `Código do erro: ${code}`;
  return errorMessage(error) || null;
}
