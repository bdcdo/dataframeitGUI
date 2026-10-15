import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Gate da classe "spec E2E sem diagnóstico de navegação". O `test` de
// e2e/base-test.ts registra as navegações e, em falha, imprime cada 404 com a
// origem (rota não casada, notFound() do app, protect do Clerk). Spec que
// importa `test` direto de @playwright/test perde isso sem nenhum aviso, e a
// falha volta a mostrar só a mensagem do spec, que costuma acusar o fixture.
// fixture-lock-test.ts estende base-test.ts, então importar de lá também vale.

const ALLOWED_TEST_SOURCES = ['"./base-test"', '"./fixture-lock-test"'];
const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+("[^"]+")/g;

function testImportProblems(source: string): string[] {
  const problems: string[] = [];
  let importsTest = false;
  for (const [, typeOnly, names, from] of source.matchAll(IMPORT)) {
    if (typeOnly) continue;
    const values = names
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "));
    if (!values.some((n) => n === "test" || n.startsWith("test as "))) continue;
    importsTest = true;
    if (!ALLOWED_TEST_SOURCES.includes(from)) {
      problems.push(`importa \`test\` de ${from}`);
    }
  }
  if (!importsTest) problems.push("não importa `test` de ./base-test nem de ./fixture-lock-test");
  return problems;
}

const E2E_DIR = resolve(__dirname, "../../../e2e");
const specs = readdirSync(E2E_DIR)
  .filter((name) => name.endsWith(".spec.ts"))
  .map((name) => ({ name, source: readFileSync(join(E2E_DIR, name), "utf8") }));

describe("specs E2E usam o test com diagnóstico de navegação", () => {
  it("há specs para conferir", () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each(specs)("$name importa test de ./base-test ou ./fixture-lock-test", ({ source }) => {
    expect(testImportProblems(source)).toEqual([]);
  });

  it("fixture-lock-test.ts estende o test de ./base-test", () => {
    const source = readFileSync(join(E2E_DIR, "fixture-lock-test.ts"), "utf8");
    expect(source).toMatch(/import\s+\{\s*test as base\s*\}\s+from\s+"\.\/base-test"/);
  });

  it.each([
    ['import { test, expect } from "@playwright/test";', ['importa `test` de "@playwright/test"']],
    ['import { test as it, expect } from "@playwright/test";', ['importa `test` de "@playwright/test"']],
    ['import { expect, type Page } from "@playwright/test";', ["não importa `test` de ./base-test nem de ./fixture-lock-test"]],
    ['import { type Page } from "@playwright/test";\nimport { test, expect } from "./base-test";', []],
    ['import { expect } from "@playwright/test";\nimport { test } from "./fixture-lock-test";', []],
  ])("a regra pega: %s", (source, expected) => {
    expect(testImportProblems(source)).toEqual(expected);
  });
});
