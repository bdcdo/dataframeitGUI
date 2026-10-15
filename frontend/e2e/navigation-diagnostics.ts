// Diagnóstico de navegação para falha de spec E2E.
//
// Um spec que navega para uma página do projeto e não acha o que espera falha
// com a mensagem do próprio spec ("confira o fixture e o reset"), mas o 404 por
// trás pode ter três origens que pedem correções diferentes:
//
// - rota não casada: o servidor Next não reconheceu o caminho e serviu a página
//   `/_not-found`. Nem layout nem página do app rodaram, então o fixture não tem
//   culpa. No `next dev`, acontece com a rota que a varredura do app dir ainda
//   não registrou.
// - `notFound()` do app: um layout ou a página rodaram e decidiram 404 (projeto
//   inexistente, sem acesso). Aqui sim vale conferir fixture, membros e reset.
// - 404 do Clerk: o `auth.protect()` do middleware recusou a sessão e reescreveu
//   a request para `/clerk_<timestamp>`.
//
// O sinal que separa as duas primeiras é a raiz da árvore de segmentos no
// payload RSC (`["",{"children":["<segmento>"`): `/_not-found` quando a rota não
// casou, o primeiro segmento do app (`(app)`) quando o layout chamou
// `notFound()`. Ele existe em `next dev` e em `next start`. Os `pagePath` vão
// junto como evidência, mas só o `next dev` os emite. Uma navegação do cliente
// entre duas páginas que compartilham layouts pode trazer só a subárvore a partir
// do segmento que mudou, sem a raiz: aí `rootSegment` fica null e o 404 sai sem
// veredito, em vez de classificado errado.
//
// As funções puras abaixo classificam um registro de navegação; o fixture que
// coleta os registros e os anexa em falha mora em base-test.ts.

export type NotFoundOrigin = "rota-nao-casada" | "notfound-do-app" | "clerk-protect";

export interface NavigationRecord {
  method: string;
  url: string;
  status: number;
  /** `x-middleware-rewrite` da resposta, quando o middleware reescreveu. */
  middlewareRewrite: string | null;
  /** `x-clerk-auth-reason` da resposta. */
  clerkAuthReason: string | null;
  /** Primeiro filho da raiz na árvore de segmentos do payload RSC. */
  rootSegment: string | null;
  /** `pagePath` de cada segmento no payload RSC (só `next dev`). */
  pagePaths: string[];
}

// No HTML, o payload RSC chega em strings JSON dentro de
// `self.__next_f.push([1,"..."])`; numa navegação do cliente (`?_rsc=`) o corpo
// já é o payload cru.
const FLIGHT_CHUNK = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
const ROOT_SEGMENT = /\["",\{"children":\["([^"]*)"/;
const PAGE_PATH = /"pagePath":"([^"]*)"/g;
const NOT_FOUND_SEGMENT = "/_not-found";
// Ver `handleControlFlowErrors` em @clerk/nextjs/dist/esm/server/clerkMiddleware.js.
const CLERK_REWRITE = /\/clerk_\d+(?:$|[?#])/;
const CLERK_PROTECT_REASON = "protect-rewrite";
// Parâmetros do handshake e do dev browser do Clerk carregam tokens de sessão;
// o registro vai para test-results/ e para o log do pre-push.
const CLERK_QUERY_PARAM = /^__clerk/;

function flightPayload(body: string): string {
  const chunks = [...body.matchAll(FLIGHT_CHUNK)];
  if (chunks.length === 0) return body;
  return chunks
    .map(([, literal]) => {
      try {
        return JSON.parse(literal) as string;
      } catch {
        return "";
      }
    })
    .join("");
}

export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const name of [...u.searchParams.keys()]) {
    if (CLERK_QUERY_PARAM.test(name)) {
      u.searchParams.set(name, "<omitido>");
      changed = true;
    }
  }
  return changed ? u.toString() : url;
}

export function readRscPayload(body: string): Pick<NavigationRecord, "rootSegment" | "pagePaths"> {
  const payload = flightPayload(body);
  const pagePaths = new Set<string>();
  for (const [, pagePath] of payload.matchAll(PAGE_PATH)) pagePaths.add(pagePath);
  return {
    rootSegment: ROOT_SEGMENT.exec(payload)?.[1] ?? null,
    pagePaths: [...pagePaths],
  };
}

export function classifyNotFound(record: NavigationRecord): NotFoundOrigin | null {
  if (record.status !== 404) return null;
  // O Clerk vem primeiro: a página para onde ele reescreve também é um
  // `/_not-found`, indistinguível de rota não casada pela árvore. Só o motivo
  // `protect-rewrite` conta: o middleware manda `x-clerk-auth-reason` em quase
  // toda resposta (`dev-browser-missing`, `session-token-and-uat-missing`),
  // inclusive no 404 de rota não casada.
  if (
    record.clerkAuthReason === CLERK_PROTECT_REASON ||
    (record.middlewareRewrite !== null && CLERK_REWRITE.test(record.middlewareRewrite))
  ) {
    return "clerk-protect";
  }
  if (record.rootSegment === NOT_FOUND_SEGMENT) return "rota-nao-casada";
  if (record.rootSegment !== null) return "notfound-do-app";
  // 404 sem payload RSC (corpo vazio, resposta de API): sem veredito.
  return null;
}

const ORIGIN_EXPLANATION: Record<NotFoundOrigin, string> = {
  "rota-nao-casada":
    "rota não casada pelo servidor Next (página /_not-found; layout e página do app não rodaram). Não é fixture nem reset",
  "notfound-do-app":
    "notFound() do app (um layout ou a página rodaram e decidiram 404). Conferir fixture, membros e reset",
  "clerk-protect": "auth.protect() do Clerk reescreveu para 404 (sessão recusada)",
};

export function describeNavigation(record: NavigationRecord): string {
  const origin = classifyNotFound(record);
  let path = record.url;
  try {
    const u = new URL(record.url);
    path = u.pathname + u.search;
  } catch {
    // URL relativa ou malformada: mostra como veio.
  }
  const verdict = origin ? ` — ${ORIGIN_EXPLANATION[origin]}` : "";
  return `${record.method} ${path} → ${record.status}${verdict}`;
}
