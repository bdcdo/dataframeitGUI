import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { RULE_NAME } from "../../../eslint-rules/test-jsdom-warm-up.mjs";

const frontendRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ruleId = `test-jsdom-warm-up/${RULE_NAME}`;
const eslint = new ESLint({
  cwd: frontendRoot,
  overrideConfigFile: "eslint.config.mjs",
});

async function messageIdsFor(
  code: string,
  filePath = "src/components/__tests__/Example.test.tsx",
) {
  const [result] = await eslint.lintText(code, { filePath });
  return (
    result?.messages
      .filter((message) => message.ruleId === ruleId)
      .map((message) => message.messageId) ?? []
  );
}

// Montado por partes: o Vitest escolhe o ambiente pela primeira ocorrência do
// pragma em qualquer ponto do texto, e o literal inteiro aqui faria este
// arquivo rodar em jsdom.
const PRAGMA = "@vitest-" + "environment";
const JSDOM = `// ${PRAGMA} jsdom\n`;
const RENDER = 'import { render } from "@testing-library/react";\n';
const IMPORTS = `
  import { beforeAll, it } from "vitest";
  import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
`;

describe("regra de aquecimento do jsdom em arquivo de teste", () => {
  // Mesma carga a frio de test-cold-imports.test.ts: o primeiro lintText
  // carrega eslint.config.mjs com o grafo do eslint-config-next.
  beforeAll(async () => {
    await messageIdsFor("export {};");
  }, 30_000);

  it("reprova arquivo jsdom que chama render() sem aquecimento", async () => {
    await expect(
      messageIdsFor(`${JSDOM}${RENDER}
        import { it } from "vitest";
        it("caso", async () => { render(null); });
      `),
    ).resolves.toEqual(["missingWarmUp"]);
  });

  it("aceita as formas de beforeAll do topo que aguardam o aquecimento", async () => {
    const forms = [
      "beforeAll(() => warmUpJsdom(), 30_000);",
      "beforeAll(() => warmUpJsdom({ select: true }), 30_000);",
      "beforeAll(async () => { await warmUpJsdom(); }, 30_000);",
      "beforeAll(function () { return warmUpJsdom(); }, 30_000);",
      "let ran; beforeAll(async () => { ran = await warmUpJsdom(); }, 30_000);",
    ];
    for (const form of forms) {
      await expect(
        messageIdsFor(`${JSDOM}${RENDER}${IMPORTS}${form}
          it("caso", async () => { render(null); });
        `),
      ).resolves.toEqual([]);
    }
  });

  it("exige prazo próprio no beforeAll do aquecimento", async () => {
    await expect(
      messageIdsFor(`${JSDOM}${RENDER}${IMPORTS}
        beforeAll(() => warmUpJsdom());
      `),
    ).resolves.toEqual(["missingDeadline"]);
  });

  // Um beforeAll dentro de describe não roda antes dos testes de outro
  // describe; sem aguardar, o hook termina antes do aquecimento; e uma função
  // declarada no callback só aquece se alguém a chamar.
  it("não conta aquecimento aninhado, sem await ou só declarado", async () => {
    const forms = [
      'describe("bloco", () => { beforeAll(() => warmUpJsdom(), 30_000); });',
      "beforeAll(() => { void warmUpJsdom(); }, 30_000);",
      "beforeAll(() => { const aquecer = () => warmUpJsdom(); }, 30_000);",
    ];
    for (const form of forms) {
      await expect(
        messageIdsFor(`${JSDOM}${RENDER}${IMPORTS}${form}`),
      ).resolves.toEqual(["missingWarmUp"]);
    }
  });

  // O Vitest lê o pragma fora de comentário e só vale a primeira ocorrência.
  it("reconhece o ambiente pelo critério do Vitest", async () => {
    await expect(
      messageIdsFor(`const ambiente = "${PRAGMA} jsdom";\n${RENDER}render(null);`),
    ).resolves.toEqual(["missingWarmUp"]);
    await expect(
      messageIdsFor(`// ${PRAGMA} node\n${JSDOM}${RENDER}render(null);`),
    ).resolves.toEqual([]);
  });

  it("não se aplica a arquivo node, a renderHook nem a import de tipo", async () => {
    await expect(
      messageIdsFor(`${RENDER}
        import { it } from "vitest";
        it("caso", () => { render(null); });
      `),
    ).resolves.toEqual([]);
    await expect(
      messageIdsFor(`${JSDOM}
        import { renderHook, screen } from "@testing-library/react";
        import userEvent from "@testing-library/user-event";
        import { it } from "vitest";
        it("caso", () => { renderHook(() => null); void screen; void userEvent; });
      `),
    ).resolves.toEqual([]);
    await expect(
      messageIdsFor(`${JSDOM}
        import { type render } from "@testing-library/react";
        let renderizar: typeof render;
      `),
    ).resolves.toEqual([]);
  });

  it("só se aplica a arquivos de teste", async () => {
    await expect(
      messageIdsFor(`${JSDOM}${RENDER}render(null);`, "src/lib/helper.ts"),
    ).resolves.toEqual([]);
  });
});
