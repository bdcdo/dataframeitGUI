// Retorna "auto" quando o usuário pediu menos animação (prefers-reduced-motion),
// senão "smooth". Usar nos call sites de scrollIntoView para respeitar a
// preferência de acessibilidade.
export function getScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
