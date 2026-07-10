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
