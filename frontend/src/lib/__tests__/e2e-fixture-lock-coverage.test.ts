import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Gate da classe "spec E2E que muta fixture remoto sem lock entre execuções".
// Duas execuções desses specs rodando juntas apagam os dados uma da outra, e a
// vítima reprova numa asserção que acusa o produto. O lock está em
// e2e/fixture-lock-test.ts. A regra abaixo exige, em cada `test(...)` que
// escreve no banco por fora da UI, um `await holdFixtureLock(` fora de
// comentário e ANTES da primeira escrita; os casos de `lockCoverageProblems`
// fixam o que ela pega.
//
// O que fica de fora, por ser leitura textual: escrita feita por helper
// definido fora do corpo do teste, e spec que muta só pela UI. Hoje nenhum spec
// faz nenhum dos dois (o de sorteio para na prévia de propósito).

const WRITE = /\.(delete|update|insert|upsert|rpc)\(/;
const LOCK = /await holdFixtureLock\(/;
const TEST_DECLARATION = /\btest\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

function stripComments(source: string): string {
  // `[^:]` antes de `//` preserva URLs dentro de strings ("http://...").
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function lockCoverageProblems(source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  if (
    code.includes("SUPABASE_SERVICE_ROLE_KEY") &&
    !code.includes('import { test } from "./fixture-lock-test"')
  ) {
    problems.push("usa a service key sem importar `test` de ./fixture-lock-test");
  }
  const declarations = [...code.matchAll(TEST_DECLARATION)];
  declarations.forEach((match, i) => {
    const body = code.slice(match.index, declarations[i + 1]?.index);
    const write = body.search(WRITE);
    if (write < 0) return;
    const title = match[1].slice(1, -1);
    const lock = body.search(LOCK);
    if (lock < 0) {
      problems.push(`teste "${title}": escreve sem \`await holdFixtureLock(...)\``);
    } else if (lock > write) {
      problems.push(`teste "${title}": escreve antes de \`await holdFixtureLock(...)\``);
    }
  });
  return problems;
}

const E2E_DIR = resolve(__dirname, "../../../e2e");

const specs = readdirSync(E2E_DIR)
  .filter((name) => name.endsWith(".spec.ts"))
  .map((name) => ({
    name,
    source: readFileSync(join(E2E_DIR, name), "utf8"),
  }));

describe("specs E2E que mutam fixture remoto", () => {
  it.each(specs)("$name toma o lock antes de escrever, em todo teste", ({ source }) => {
    expect(lockCoverageProblems(source)).toEqual([]);
  });

  it("os specs que escrevem no fixture são reconhecidos como tal", () => {
    const flagged = specs
      .filter(({ source }) =>
        lockCoverageProblems(source.replace(/await holdFixtureLock\(/g, "noop(")).length > 0,
      )
      .map(({ name }) => name);
    expect(flagged).toEqual(
      expect.arrayContaining([
        "coding-save.smoke.spec.ts",
        "compare-field-switch.smoke.spec.ts",
        "llm-decisions.smoke.spec.ts",
      ]),
    );
  });
});

const IMPORT = 'import { test } from "./fixture-lock-test";\n';

describe("lockCoverageProblems", () => {
  it("aceita lock antes do reset em cada teste", () => {
    const source = `${IMPORT}
test("a", async ({ holdFixtureLock }) => {
  await holdFixtureLock(id);
  await admin.from("reviews").delete().eq("project_id", id);
});
test("b", async ({ holdFixtureLock }) => {
  await holdFixtureLock(id);
  await admin.from("responses").delete();
});`;
    expect(lockCoverageProblems(source)).toEqual([]);
  });

  it("acusa lock tomado depois do primeiro DELETE", () => {
    const source = `${IMPORT}
test("a", async ({ holdFixtureLock }) => {
  await admin.from("reviews").delete().eq("project_id", id);
  await holdFixtureLock(id);
});`;
    expect(lockCoverageProblems(source)).toEqual([
      'teste "a": escreve antes de `await holdFixtureLock(...)`',
    ]);
  });

  it("acusa teste sem lock mesmo que outro teste chame duas vezes", () => {
    const source = `${IMPORT}
test("a", async ({ holdFixtureLock }) => {
  await holdFixtureLock(id);
  await holdFixtureLock(id);
  await admin.from("x").delete();
});
test("b", async () => {
  await admin.from("x").update({});
});`;
    expect(lockCoverageProblems(source)).toEqual([
      'teste "b": escreve sem `await holdFixtureLock(...)`',
    ]);
  });

  it("não aceita a chamada comentada", () => {
    const source = `${IMPORT}
test("a", async () => {
  // await holdFixtureLock(id);
  /* await holdFixtureLock(id); */
  await admin.from("x").insert({});
});`;
    expect(lockCoverageProblems(source)).toEqual([
      'teste "a": escreve sem `await holdFixtureLock(...)`',
    ]);
  });

  it("exige o test com o fixture quando o spec usa a service key", () => {
    const source = `import { test } from "@playwright/test";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
test("a", async () => {});`;
    expect(lockCoverageProblems(source)).toEqual([
      "usa a service key sem importar `test` de ./fixture-lock-test",
    ]);
  });

  it("ignora spec só de leitura", () => {
    const source = `import { test } from "@playwright/test";
test("a", async ({ page }) => {
  await page.goto("/dashboard");
});`;
    expect(lockCoverageProblems(source)).toEqual([]);
  });
});
