import { expect } from "vitest";

// Copy e linha de log de `serverErrorCopy` no servidor, que levam um código
// sorteado por erro: `copy — código <código>` no toast e
// `[erro <código>] <escopo> {"code":…,"message":…}` no log, numa linha só.
const REF = "[0-9a-z]{6,7}";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function copyWithRef(copy: string) {
  return expect.stringMatching(new RegExp(`^${escape(copy)} — código ${REF}$`));
}

/**
 * A linha `[erro <código>] <escopo> <json>` de `serverErrorCopy`. O escopo é
 * exato (string) ou um padrão (RegExp, sem âncoras); `payload`, quando dado,
 * confere só as chaves que traz (`expect.objectContaining`).
 */
export function loggedLine(scope: string | RegExp, payload?: Record<string, unknown>) {
  const scopePattern = typeof scope === "string" ? escape(scope) : scope.source;
  const description = `loggedLine(${String(scope)}, ${JSON.stringify(payload)})`;
  const line = new RegExp(`^\\[erro ${REF}\\] (?:${scopePattern}) (\\{.*\\})$`);
  return {
    asymmetricMatch(actual: unknown): boolean {
      if (typeof actual !== "string") return false;
      const json = line.exec(actual)?.[1];
      if (json === undefined) return false;
      if (!payload) return true;
      return expect.objectContaining(payload).asymmetricMatch(JSON.parse(json));
    },
    toString: () => description,
    toAsymmetricMatcher: () => description,
  };
}
