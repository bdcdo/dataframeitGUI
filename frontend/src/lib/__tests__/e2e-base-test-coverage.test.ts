import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Gate da classe "spec E2E sem diagnóstico de navegação". O `test` de
// e2e/base-test.ts registra as navegações e, em falha, imprime cada 404 com a
// origem (rota não casada, notFound() do app, protect do Clerk). Spec que
// importa `test` direto de @playwright/test perde isso sem nenhum aviso, e a
// falha volta a mostrar só a mensagem do spec, que costuma acusar o fixture.
// fixture-lock-test.ts estende base-test.ts, então importar de lá também vale.

const E2E_DIR = resolve(__dirname, "../../../e2e");
const ALLOWED_TEST_MODULES = ["base-test", "fixture-lock-test"].map((name) => join(E2E_DIR, name));
// Mesmo padrão do `testMatch` default do Playwright, que a config não troca no
// projeto chromium: o gate enxerga todo arquivo que a suíte roda.
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
// Cláusula de import de valor em qualquer forma: `import X`, `import * as X`,
// `import { ... }` e combinações, com aspas simples ou duplas.
const IMPORT = /import\s+(type\s+)?([\w$*\s{},]+?)\s+from\s+(["'])([^"']+)\3/g;

function importsTestBinding(clause: string, from: string): boolean {
  const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
  const values = named
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && !n.startsWith("type "));
  if (values.some((n) => n === "test" || n.startsWith("test as "))) return true;
  // O export default e o namespace de @playwright/test também entregam o `test`.
  const outside = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
  return from === "@playwright/test" && outside !== "";
}

function testImportProblems(source: string, fileDir = E2E_DIR): string[] {
  const problems: string[] = [];
  let importsTest = false;
  for (const [, typeOnly, clause, , from] of source.matchAll(IMPORT)) {
    if (typeOnly || !importsTestBinding(clause, from)) continue;
    importsTest = true;
    const target = from.startsWith(".") ? resolve(fileDir, from).replace(/\.[cm]?[jt]s$/, "") : null;
    if (target === null || !ALLOWED_TEST_MODULES.includes(target)) {
      problems.push(`importa \`test\` de "${from}"`);
    }
  }
  if (!importsTest) problems.push("não importa `test` de ./base-test nem de ./fixture-lock-test");
  return problems;
}

const specs = (readdirSync(E2E_DIR, { recursive: true }) as string[])
  .filter((name) => TEST_FILE.test(name))
  .map((name) => {
    const path = join(E2E_DIR, name);
    return { name, dir: dirname(path), source: readFileSync(path, "utf8") };
  });

describe("specs E2E usam o test com diagnóstico de navegação", () => {
  it("há specs para conferir", () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each(specs)("$name importa test de ./base-test ou ./fixture-lock-test", ({ source, dir }) => {
    expect(testImportProblems(source, dir)).toEqual([]);
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
    ["import { test as pwTest } from '@playwright/test';\nimport { test } from './base-test';", ['importa `test` de "@playwright/test"']],
    ['import pwTest, { expect } from "@playwright/test";\nimport { test } from "./base-test";', ['importa `test` de "@playwright/test"']],
    ['import * as pw from "@playwright/test";\nimport { test } from "./base-test";', ['importa `test` de "@playwright/test"']],
    ['import { test } from "./helpers";', ['importa `test` de "./helpers"']],
  ])("a regra pega: %s", (source, expected) => {
    expect(testImportProblems(source)).toEqual(expected);
  });

  it("resolve o import relativo a partir do diretório do spec", () => {
    const sub = join(E2E_DIR, "sub");
    expect(testImportProblems('import { test } from "../base-test";', sub)).toEqual([]);
    expect(testImportProblems('import { test } from "./base-test";', sub)).toEqual([
      'importa `test` de "./base-test"',
    ]);
  });
});
