// Diagnóstico de navegação para falha de spec E2E.
//
// Um spec que navega para uma página do projeto e não acha o que espera falha
// com a mensagem do próprio spec, mas o 404 por trás pode ter três origens que
// pedem correções diferentes:
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
  for (const [name, value] of [...u.searchParams]) {
    // O `redirect_url` do login carrega a URL de origem, que pode trazer o
    // token do Clerk dentro dela.
    const nested = CLERK_QUERY_PARAM.test(name)
      ? "<omitido>"
      : URL.canParse(value)
        ? redactUrl(value)
        : value;
    if (nested !== value) {
      u.searchParams.set(name, nested);
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

// Rota de login do app (NEXT_PUBLIC_CLERK_SIGN_IN_URL e `requirePageAuthUser`)
// e a do login hospedado do Clerk, para onde vai quem não define aquela.
const LOGIN_PATH = /^\/(?:auth\/login|sign-in)(?:\/|$)/;

// Código que `errorDetail` (src/lib/server-error.ts) põe no painel de erro do
// app, o mesmo da linha `[erro <código>]` que o `onRequestError`
// (src/instrumentation.ts) loga. O código é hash do erro, não pista da origem:
// só o log diz por que o servidor falhou (#527). `formatErrorCode` dá 6 ou 7
// caracteres em base 36 (o digest tem 32 bits).
const ERROR_CODE = "[0-9a-z]{6,7}";
const ERROR_SCREEN_CODE = new RegExp(`Código do erro: (${ERROR_CODE})`);

function logLineHint(code: string): string {
  return (
    `a linha "[erro ${code}]" do log do servidor ([WebServer] nesta saída, ` +
    "ou o terminal do servidor reaproveitado) traz a mensagem e o stack"
  );
}

export function describeErrorScreen(pageText: string): string | null {
  const code = ERROR_SCREEN_CODE.exec(pageText)?.[1];
  if (!code) return null;
  return `tela de erro de servidor, código ${code}: ${logLineHint(code)}`;
}

// Falha de Server Action não chega ao boundary: vira toast fora do `<main>`,
// com o código na copy (`appendErrorCode` em src/lib/server-error.ts, pelo
// `serverErrorCopy`/`caughtErrorCopy` do servidor ou pelo `withErrorCode` do
// cliente), o mesmo da linha `[erro <código>]` do log. O toast some em 4 s (o
// default do sonner), antes de o spec desistir de esperar, então o código é
// colhido enquanto ele aparece, e não no teardown.
export const TOAST_CODE_PATTERN = `— código (${ERROR_CODE})(?![0-9a-z])`;
const TOAST_CODE_ONLY = new RegExp(`^${ERROR_CODE}$`);

interface ToastCodeWatch {
  /** Nome da função que `context.exposeBinding` pôs na página. */
  binding: string;
  pattern: string;
}

// Roda dentro da página, via `addInitScript`: o Playwright a serializa, então
// não pode usar nada de fora dela. Só o código sai da página; o texto do toast,
// que pode trazer dado do usuário, fica nela. Para não pesar no teste que
// passa, só o frame do topo (onde mora o Toaster) observa, e só lote de
// mutações que toca o toaster faz a busca.
export function watchToastCodes({ binding, pattern }: ToastCodeWatch): void {
  if (window !== window.top) return;
  const toaster = "[data-sonner-toaster]";
  const codePattern = new RegExp(pattern, "g");
  const seen = new Set<string>();
  const touchesToaster = (record: MutationRecord): boolean => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest(toaster)) return true;
    // O `<ol>` do toaster só nasce com o primeiro toast; os ancestrais dos nós
    // inseridos são os do `target`, já conferidos acima.
    for (const node of record.addedNodes) {
      if (node instanceof Element && node.matches(toaster)) return true;
    }
    return false;
  };
  new MutationObserver((records) => {
    if (!records.some(touchesToaster)) return;
    // Título e descrição um a um: o `textContent` do toast inteiro cola o fim
    // do título no começo da descrição. A regra contra consulta do DOM no
    // navegador protege de pegar a primeira cópia, que pode ser a órfã de um
    // segmento de Suspense; aqui todas as cópias são lidas, e um init script
    // não tem locator nem visivel().
    // eslint-disable-next-line no-restricted-syntax
    for (const element of document.querySelectorAll(
      "[data-sonner-toast] [data-title], [data-sonner-toast] [data-description]",
    )) {
      for (const [, code] of (element.textContent ?? "").matchAll(codePattern)) {
        if (seen.has(code)) continue;
        seen.add(code);
        const report = (window as unknown as Record<string, unknown>)[binding];
        // Página fechando: a chamada falha, e o código perdido não derruba o app.
        if (typeof report === "function") {
          Promise.resolve()
            .then(() => report(code))
            .catch(() => undefined);
        }
      }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}

// Do lado do teste, o binding só aceita o formato do código: o que mais a
// página mandasse não chega à saída.
export function isToastCode(value: unknown): value is string {
  return typeof value === "string" && TOAST_CODE_ONLY.test(value);
}

export function describeToastCode(code: string): string {
  return `toast com código ${code}: ${logLineHint(code)}`;
}

// URL final do frame principal de uma página, para o teste que falhou: é ela
// que mostra o redirecionamento ao login, que a mensagem do spec ("pergunta
// não apareceu") não tem como saber (#740). Com o texto da página, aponta
// também a tela de erro de servidor, que pode chegar com status 200 (erro
// dentro do layout do projeto) e então não aparece nas navegações com erro.
// Os parâmetros do Clerk saem redigidos, como nas navegações.
export function describeFinalUrl(url: string, pageText = ""): string {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    // about:blank ou URL malformada: mostra como veio.
  }
  const login = LOGIN_PATH.test(path)
    ? "tela de login: o login do spec não terminou, ou a sessão não valeu para o servidor"
    : null;
  return [redactUrl(url), login, describeErrorScreen(pageText)]
    .filter(Boolean)
    .join(" — ");
}

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
