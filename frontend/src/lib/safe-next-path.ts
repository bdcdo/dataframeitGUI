// Sanitiza um destino de redirect vindo de `?next` para impedir open-redirect.
// `startsWith("/")` sozinho é insuficiente: aceita "//evil.com"
// (protocol-relative) e "/\\evil.com" (barra invertida normalizada para "/" em
// esquemas http), ambos interpretados pelo navegador como URL absoluta para
// outro host. A checagem robusta resolve o valor contra uma base fixa e só
// aceita se a origin resultante continuar sendo a base — ou seja, é um caminho
// interno de verdade. Pura e testável (usada pela tela de conclusão de acesso).
export function safeNextPath(
  next: string | undefined,
  fallback = "/dashboard",
): string {
  if (!next) return fallback;
  try {
    const base = "http://internal.invalid";
    const url = new URL(next, base);
    // Qualquer destino que escape para outra origin (protocol-relative, host
    // absoluto, backslash) muda a origin e é descartado.
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    // Entrada malformada → fallback seguro.
    return fallback;
  }
}

// Monta o destino de conclusão de acesso preservando o deep-link pretendido em
// `?next` (lido do header `x-pathname` injetado pelo middleware). Sanitiza o
// pathname antes de embutir; sem um destino interno válido, vai à tela sem
// `?next` (post-login cai no fallback /dashboard).
export function completionRedirectPath(
  pathname: string | null | undefined,
): string {
  const next = pathname ? safeNextPath(pathname, "") : "";
  return next
    ? `/auth/post-login?next=${encodeURIComponent(next)}`
    : "/auth/post-login";
}
