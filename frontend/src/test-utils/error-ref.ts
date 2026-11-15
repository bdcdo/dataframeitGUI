import { expect } from "vitest";

// Copy e escopo de log de `serverErrorCopy`, que levam um código sorteado por
// erro (`[erro <código>] escopo` no log, `copy — código <código>` no toast).
const REF = "[0-9a-z]{6,7}";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function copyWithRef(copy: string) {
  return expect.stringMatching(new RegExp(`^${escape(copy)} — código ${REF}$`));
}

export function loggedScope(scope: string | RegExp) {
  const pattern = typeof scope === "string" ? escape(scope) : scope.source.replace(/^\^/, "");
  return expect.stringMatching(new RegExp(`^\\[erro ${REF}\\] ${pattern}`));
}
