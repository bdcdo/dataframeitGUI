import { errorMessage } from "@/lib/utils";
import { ActionTimeoutError, ACTION_TIMEOUT_MESSAGE } from "@/lib/action-timeout";

// Erro de servidor numa Server Action (Postgres, PostgREST, backend): o texto
// é diagnóstico de desenvolvedor, em inglês, e não serve ao toast pt-BR, mas
// também não pode sumir. Vai para o log do servidor, e o toast recebe a copy
// do fluxo (#502).
//
// Erro capturado não passa pelo `onRequestError` e não tem digest do Next
// (ver `errorCode`): o código que liga o toast à linha do log é sorteado aqui,
// no mesmo formato — base 36, 6 ou 7 caracteres — e a linha do log começa por
// `[erro <código>]`, como a do `src/instrumentation.ts`. Assim
// `fly logs | grep <código>` acha os dois tipos de erro do mesmo jeito.
//
// `byCode` mapeia os códigos que descrevem uma condição real que o usuário
// pode entender (registro já resolvido, sem permissão): esses ganham copy
// própria e não vão ao log, porque são estado esperado e não falha.
export interface ServerError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

// Exceção lançada de propósito dentro do `try` de uma action, com copy pt-BR
// para o toast: `caughtErrorCopy` a devolve como veio e não a loga, porque é
// estado esperado (sem permissão, registro inexistente, guarda de uma RPC que
// levanta texto pt-BR), e não falha.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

// Códigos cujo `details` diz qual chave colidiu ou faltou, o que o `message`
// não diz: unique (23505) e foreign key (23503). O `details` de outros códigos
// pode trazer a linha inteira ("Failing row contains (...)"), e fica fora.
const KEY_DETAIL_CODES = new Set(["23505", "23503"]);

// "Key (email)=(ana@x.com) already exists." vira "Key (email)=(…) already
// exists.": a coluna diz o que colidiu; o valor é dado de usuário e não vai ao
// log. O valor vai do "=(" até o ")" que antecede o fim conhecido da frase do
// Postgres, então parêntese no meio do valor não o deixa escapar. Fora desse
// formato, o details inteiro fica fora.
const KEY_DETAIL = /^(Key \(.*?\)=)\(.*\)( (?:already exists|is not present in table .*|is still referenced from table .*)\.?)$/;

function redactKeyValues(details: string): string | undefined {
  const match = KEY_DETAIL.exec(details);
  return match ? `${match[1]}(…)${match[2]}` : undefined;
}

function stringProp(e: unknown, key: string): string | undefined {
  if (typeof e !== "object" || e === null || !(key in e)) return undefined;
  const value = (e as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

// O que um erro do Postgres acrescenta à linha de log, além da mensagem: o
// `code`, o `details` redigido nos códigos de chave e o `hint`, que é texto do
// Postgres ou da RPC e não traz dado. Lido de qualquer objeto com essas chaves
// (PostgrestError, PostgrestWriteError), inclusive pelo `instrumentation.ts`.
export function postgresLogFields(error: unknown): {
  code?: string;
  details?: string;
  hint?: string;
} {
  const code = stringProp(error, "code");
  const details = stringProp(error, "details");
  const hint = stringProp(error, "hint");
  return {
    ...(code !== undefined && { code }),
    ...(details && code && KEY_DETAIL_CODES.has(code) && {
      details: redactKeyValues(details),
    }),
    ...(hint && { hint }),
  };
}

function logDetail(error: ServerError): Record<string, string | undefined> {
  // O code abre a linha, antes da mensagem, como sempre saiu no log.
  const { code, ...rest } = postgresLogFields(error);
  return { code, message: error.message, ...rest };
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
  // No navegador (o `fetchFastAPI` dos componentes cliente), o log fica no
  // console de quem usa: um código ali não acharia nada no `fly logs`.
  const detail = logDetail(error);
  if (typeof window !== "undefined") {
    console.error(scope, detail);
    return copy.generic;
  }
  // Uma linha só, com o JSON no fim, como a do `instrumentation.ts`: o objeto
  // passado à parte o Node quebra em várias linhas, e o grep pelo código
  // traria só o escopo.
  const ref = formatErrorCode(crypto.getRandomValues(new Uint32Array(1))[0]);
  console.error(`[erro ${ref}] ${scope} ${JSON.stringify(detail)}`);
  return appendErrorCode(copy.generic, ref);
}

// Um formato só para o código sorteado e o do digest, que o grep acha igual.
function formatErrorCode(n: number): string {
  return n.toString(36).padStart(6, "0");
}

function appendErrorCode(copy: string, code: string): string {
  return `${copy} — código ${code}`;
}

// O mesmo para o módulo de actions que loga vários passos: o escopo do log sai
// sempre como `[modulo] passo falhou`.
export function serverErrorScope(module: string) {
  return (step: string, error: ServerError, generic: string): string =>
    serverErrorCopy(`[${module}] ${step} falhou`, error, { generic });
}

// Exceção capturada num `catch` (rede, PostgREST, erro lançado por helper):
// vai para o log com o `code`, o `details` e o `hint`, quando o erro os
// carrega (PostgrestWriteError, por exemplo), e o toast recebe a copy
// genérica. `UserFacingError` (e o `ZeroRowsError`, que a estende) já é a copy
// do toast e passa como veio.
export function caughtErrorCopy(scope: string, e: unknown, generic: string): string {
  if (e instanceof UserFacingError) return e.message;
  return serverErrorCopy(
    scope,
    {
      code: stringProp(e, "code"),
      message: errorMessage(e),
      details: stringProp(e, "details"),
      hint: stringProp(e, "hint"),
    },
    { generic },
  );
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
  return formatErrorCode(Number(digest));
}

// Server Action que o servidor não reconhece: a página foi aberta antes de um
// deploy que mudou os IDs das actions (rotação de
// NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, ver README). O servidor responde com
// `x-nextjs-action-not-found` e o cliente do Next lança
// `UnrecognizedActionError`. Tentar de novo repete o ID antigo e falha igual;
// só recarregar traz os IDs novos, e é isso que a mensagem precisa dizer.
//
// Pelo `name`, e não pelo `unstable_isUnrecognizedActionError` de
// `next/navigation`: aquele é `instanceof`, e os testes que mockam
// `next/navigation` sem ele quebrariam no `catch`. O teste deste helper usa a
// classe real do Next, para acusar se uma atualização trocar o nome.
export function isStaleActionError(error: unknown): boolean {
  return error instanceof Error && error.name === "UnrecognizedActionError";
}

export const STALE_PAGE_ERROR =
  "O sistema foi atualizado depois que esta página abriu. Recarregue a página para continuar.";

// Mensagem do toast para o `catch` de uma Server Action no cliente: exceção do
// servidor vira a copy pt-BR do fluxo com o código; erro do próprio cliente
// mantém a mensagem, como antes.
export function actionErrorMessage(error: unknown, fallback: string): string {
  if (isStaleActionError(error) || error instanceof ActionTimeoutError || errorCode(error)) {
    return withErrorCode(error, fallback);
  }
  return errorMessage(error) || fallback;
}

// O mesmo para o `catch` cuja copy pt-BR é fixa: acrescenta o código quando a
// exceção veio do servidor, e em erro do navegador (rede, por exemplo) mantém a
// copy, em vez de trocá-la pela mensagem em inglês como `actionErrorMessage`.
export function withErrorCode(error: unknown, copy: string): string {
  if (isStaleActionError(error)) return STALE_PAGE_ERROR;
  if (error instanceof ActionTimeoutError) return ACTION_TIMEOUT_MESSAGE;
  const code = errorCode(error);
  return code ? appendErrorCode(copy, code) : copy;
}

// Detalhe que as telas de erro (`error.tsx`, `global-error.tsx`) mostram: o
// código, quando o erro veio do servidor, ou a mensagem, quando o erro é do
// próprio navegador e não foi mascarado.
export function errorDetail(error: unknown): string | null {
  const code = errorCode(error);
  if (code) return `Código do erro: ${code}`;
  return errorMessage(error) || null;
}
