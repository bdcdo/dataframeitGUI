import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  RULE_NAME,
  testJsdomWarmUpPlugin,
} from "../../../eslint-rules/test-jsdom-warm-up.mjs";

const ruleId = `test-jsdom-warm-up/${RULE_NAME}`;

// Só a regra, com o parser padrão do ESLint: ela é sintática, e as fixtures são
// JavaScript puro. Carregar eslint.config.mjs, com o grafo do eslint-config-next
// e o parser de TypeScript, custava de 2 a 3 s de CPU, e com a suíte em 200% de
// CPU o beforeAll que fazia essa carga estourou os 30 s. O que depende da config
// (a regra ligada nos arquivos de teste, import só de tipo) fica em
// test-cold-imports.test.ts, que já paga essa carga.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.tsx"],
      plugins: { "test-jsdom-warm-up": testJsdomWarmUpPlugin },
      rules: { [ruleId]: "error" },
    },
  ],
});

async function messagesFor(code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: "src/components/__tests__/Example.test.tsx",
  });
  const fatal = result?.messages.find((message) => message.fatal);
  if (fatal) throw new Error(`fixture não parseou: ${fatal.message}`);
  return result?.messages.filter((message) => message.ruleId === ruleId) ?? [];
}

async function messageIdsFor(code: string) {
  return (await messagesFor(code)).map((message) => message.messageId);
}

// Montado por partes: o Vitest escolhe o ambiente pela primeira ocorrência do
// pragma em qualquer ponto do texto, e o literal inteiro aqui faria este
// arquivo rodar em jsdom.
const PRAGMA = "@vitest-" + "environment";
const JEST_PRAGMA = "@jest-" + "environment";
const JSDOM = `// ${PRAGMA} jsdom\n`;
const RENDER = 'import { render } from "@testing-library/react";\n';
const IMPORTS = `
  import { beforeAll, it } from "vitest";
  import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
`;

describe("regra de aquecimento do jsdom em arquivo de teste", () => {
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

  it("aponta o import de render quando falta o aquecimento", async () => {
    const [message] = await messagesFor(`${JSDOM}${RENDER}render(null);`);
    expect(message).toMatchObject({ line: 2, column: 10 });
  });

  // Prazo calculado não deixa conferir que ele existe nem que passa do
  // hookTimeout padrão.
  it("exige prazo próprio, literal, no beforeAll do aquecimento", async () => {
    for (const form of [
      "beforeAll(() => warmUpJsdom());",
      "beforeAll(() => warmUpJsdom(), PRAZO);",
    ]) {
      await expect(
        messageIdsFor(`${JSDOM}${RENDER}${IMPORTS}${form}`),
      ).resolves.toEqual(["missingDeadline"]);
    }
  });

  it("não conta outra função nem warmUpJsdom sem await como aquecimento", async () => {
    const forms = [
      "beforeAll(() => outra(), 30_000);",
      "beforeAll(function () { return outra(); }, 30_000);",
      "let ran; beforeAll(async () => { ran = warmUpJsdom(); }, 30_000);",
      "beforeEach(() => warmUpJsdom(), 30_000);",
    ];
    for (const form of forms) {
      await expect(
        messageIdsFor(`${JSDOM}${RENDER}${IMPORTS}${form}`),
      ).resolves.toEqual(["missingWarmUp"]);
    }
  });

  it("vale para o render do /pure e só para o da Testing Library", async () => {
    await expect(
      messageIdsFor(`${JSDOM}import { render } from "@testing-library/react/pure";\nrender(null);`),
    ).resolves.toEqual(["missingWarmUp"]);
    await expect(
      messageIdsFor(`${JSDOM}import { render } from "./render-local";\nrender(null);`),
    ).resolves.toEqual([]);
  });

  // Um beforeAll dentro de describe não roda antes dos testes de outro
  // describe; sem aguardar, o hook termina antes do aquecimento; e uma função
  // declarada no callback só aquece se alguém a chamar.
  it("não conta aquecimento aninhado, sem await ou só declarado", async () => {
    const forms = [
      'describe("bloco", () => { beforeAll(() => warmUpJsdom(), 30_000); });',
      "beforeAll(() => { void warmUpJsdom(); }, 30_000);",
      "beforeAll(() => { warmUpJsdom(); }, 30_000);",
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
    await expect(
      messageIdsFor(`// ${JEST_PRAGMA} jsdom\n${RENDER}render(null);`),
    ).resolves.toEqual(["missingWarmUp"]);
  });

  it("não se aplica a arquivo node nem a jsdom só com renderHook", async () => {
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
  });
});
