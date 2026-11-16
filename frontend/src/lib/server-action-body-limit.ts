// Teto do corpo de uma Server Action, numa fonte só: o `next.config` o passa ao
// Next (`serverActions.bodySizeLimit`), e o `proxy.ts` recusa antes dele o
// envio que o passa.
//
// Por que o proxy: acima do teto, o Next lança `ApiError(413, "Body exceeded…")`
// no action handler, mas responde 500 com o erro serializado no Flight, e em
// produção o cliente só recebe a mensagem mascarada e o digest
// (`next/dist/server/app-render/action-handler.js`, com um TODO sobre o 413).
// O digest varia a cada build, então não serve de sinal. Já uma resposta
// `text/plain` com status de erro chega ao cliente com o texto
// (`server-action-reducer.js`), e `isPayloadTooLarge` reconhece o "Body
// exceeded" dele.
const BODY_LIMIT_MB = 10;
export const SERVER_ACTION_BODY_LIMIT = `${BODY_LIMIT_MB}mb`;
// O Next lê "10mb" pela lib `bytes`, em que 1 mb é 1024 * 1024.
export const SERVER_ACTION_BODY_LIMIT_BYTES = BODY_LIMIT_MB * 1024 * 1024;

// Resposta 413 para a Server Action cujo `Content-Length` declarado passa do
// teto, ou null. Sem o cabeçalho (corpo em chunks), quem decide é o Next.
export function serverActionTooLarge(request: Request): Response | null {
  if (request.method !== "POST" || !request.headers.has("next-action")) return null;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= SERVER_ACTION_BODY_LIMIT_BYTES) return null;
  return new Response(`Body exceeded ${SERVER_ACTION_BODY_LIMIT} limit.`, {
    status: 413,
    headers: { "content-type": "text/plain" },
  });
}
