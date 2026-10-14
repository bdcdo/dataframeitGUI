import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Gate da classe "spec E2E que muta fixture remoto sem lock entre execuções".
// Spec que carrega a service key escreve no banco por fora da UI (reset,
// preparação de estado); dois deles rodando juntos apagam os dados um do outro
// e a vítima reprova numa asserção que acusa o produto. O lock está em
// e2e/fixture-lock-test.ts; este teste exige que cada `test(...)` desses specs
// o tome. A contagem é textual: um teste declarado num laço conta uma vez, e a
// chamada dentro dele também.
//
// O que fica de fora: spec que muta só pela UI, sem a service key. Hoje nenhum
// faz isso (o de sorteio para na prévia de propósito).

const E2E_DIR = resolve(__dirname, "../../../e2e");

const specs = readdirSync(E2E_DIR)
  .filter((name) => name.endsWith(".spec.ts"))
  .map((name) => ({
    name,
    source: readFileSync(join(E2E_DIR, name), "utf8"),
  }));

const mutating = specs.filter(({ source }) =>
  source.includes("SUPABASE_SERVICE_ROLE_KEY"),
);

describe("specs E2E que mutam fixture remoto", () => {
  it("são achados (o filtro não está vazio por engano)", () => {
    expect(mutating.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "coding-save.smoke.spec.ts",
        "compare-field-switch.smoke.spec.ts",
      ]),
    );
  });

  it.each(mutating)("$name toma o lock do fixture em todo teste", ({ source }) => {
    expect(source).toMatch(
      /import \{ test \} from "\.\/fixture-lock-test";/,
    );
    const declared = source.match(/\btest\(\s*[`"']/g) ?? [];
    const locked = source.match(/await holdFixtureLock\(/g) ?? [];
    expect(declared.length).toBeGreaterThan(0);
    expect(
      locked.length,
      "cada teste chama `await holdFixtureLock(projectId)` antes do primeiro reset",
    ).toBeGreaterThanOrEqual(declared.length);
  });
});
