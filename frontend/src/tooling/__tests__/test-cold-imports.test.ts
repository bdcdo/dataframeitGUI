import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { RULE_NAME } from "../../../eslint-rules/test-cold-imports.mjs";
import { RULE_NAME as WARM_UP_RULE_NAME } from "../../../eslint-rules/test-jsdom-warm-up.mjs";

const frontendRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ruleId = `test-cold-imports/${RULE_NAME}`;
const eslint = new ESLint({
  cwd: frontendRoot,
  overrideConfigFile: "eslint.config.mjs",
});

async function messagesFor(
  code: string,
  filePath = "src/lib/__tests__/example.test.ts",
) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((message) => message.ruleId === ruleId) ?? [];
}

async function messageIdsFor(code: string, filePath?: string) {
  return (await messagesFor(code, filePath)).map((message) => message.messageId);
}

describe("regra de import() a frio em arquivos de teste", () => {
  // Mesma carga a frio de server-action-exports.test.ts: o primeiro lintText
  // carrega eslint.config.mjs com o grafo do eslint-config-next.
  beforeAll(async () => {
    await messagesFor("export {};");
  }, 30_000);

  it("reprova import() dentro de teste sem carga prévia e nomeia o módulo", async () => {
    const messages = await messagesFor(`
      import { it } from "vitest";
      it("caso", async () => {
        const { run } = await import("@/actions/example");
        run();
      });
    `);

    expect(messages.map((message) => message.messageId)).toEqual(["coldImport"]);
    expect(messages[0]?.message).toContain('import("@/actions/example")');
  });

  it("reprova o import() de um helper chamado pelos testes", async () => {
    await expect(
      messageIdsFor(`
        async function load() {
          return (await import("@/actions/example")).run;
        }
      `),
    ).resolves.toEqual(["coldImport"]);
  });

  it("aceita o módulo carregado por beforeAll no topo do arquivo", async () => {
    await expect(
      messageIdsFor(`
        import { beforeAll, it } from "vitest";
        beforeAll(async () => {
          await import("@/actions/example");
        }, 30_000);
        it("caso", async () => {
          await import("@/actions/example");
        });
      `),
    ).resolves.toEqual([]);
  });

  it("aceita o módulo carregado por import estático ou na coleta", async () => {
    await expect(
      messageIdsFor(`
        import { helper } from "@/lib/estatico";
        import "@/lib/efeito";
        const { other } = await import("@/lib/na-coleta");
        helper(other);
        async function load() {
          await import("@/lib/efeito");
          await import("@/lib/estatico");
          await import("@/lib/na-coleta");
        }
      `),
    ).resolves.toEqual([]);
  });

  // O beforeAll de um describe não roda antes dos testes de outro describe, e
  // um import só de tipo não carrega o módulo.
  it("não conta beforeAll aninhado nem import de tipo como carga", async () => {
    await expect(
      messageIdsFor(`
        import type { Shape } from "@/lib/tipo";
        import { beforeAll, describe, it } from "vitest";
        describe("bloco", () => {
          beforeAll(async () => {
            await import("@/lib/aninhado");
          });
        });
        it("caso", async () => {
          await import("@/lib/aninhado");
          await import("@/lib/tipo");
        });
      `),
    ).resolves.toEqual(["coldImport", "coldImport"]);
  });

  // O transformador de TypeScript do Vitest descarta o import cujos bindings
  // não aparecem em posição de valor, e o módulo não chega a carregar.
  it("não conta import estático sem binding usado como valor", async () => {
    await expect(
      messageIdsFor(`
        import { naoUsado } from "@/lib/nao-usado";
        import { type Shape, outro } from "@/lib/so-tipo";
        import { valor } from "@/lib/usado";
        let forma: Shape | typeof outro;
        valor();
        async function load() {
          await import("@/lib/nao-usado");
          await import("@/lib/so-tipo");
          await import("@/lib/usado");
        }
      `),
    ).resolves.toEqual(["coldImport", "coldImport"]);
  });

  it("aceita carga aguardada por return, corpo de arrow e Promise.all", async () => {
    await expect(
      messageIdsFor(`
        import { beforeAll, it } from "vitest";
        beforeAll(() => import("@/lib/arrow"), 30_000);
        beforeAll(function () {
          return import("@/lib/retorno");
        }, 30_000);
        beforeAll(async () => {
          await Promise.all([import("@/lib/a"), import("@/lib/b")]);
        }, 30_000);
        it("caso", async () => {
          await import("@/lib/arrow");
          await import("@/lib/retorno");
          await import("@/lib/a");
          await import("@/lib/b");
        });
      `),
    ).resolves.toEqual([]);
  });

  // Sem await o hook termina antes do módulo; numa função declarada dentro do
  // hook, o import só roda se alguém chamar a função.
  it("não conta carga sem await nem import em função dentro do beforeAll", async () => {
    await expect(
      messageIdsFor(`
        import { beforeAll, it } from "vitest";
        beforeAll(() => {
          void import("@/lib/sem-await");
          const load = async () => import("@/lib/so-declarado");
        }, 30_000);
        it("caso", async () => {
          await import("@/lib/sem-await");
          await import("@/lib/so-declarado");
        });
      `),
    ).resolves.toEqual(["coldImport", "coldImport"]);
  });

  it("ignora o import() dentro da fábrica de vi.mock e vi.doMock", async () => {
    await expect(
      messageIdsFor(`
        import { it, vi } from "vitest";
        vi.mock("@/lib/a", async () => ({ ...(await import("@/lib/original")) }));
        it("caso", () => {
          vi.doMock("@/lib/b", async () => ({ ...(await import("react")) }));
        });
      `),
    ).resolves.toEqual([]);
  });

  it("reprova especificador calculado dentro de teste", async () => {
    await expect(
      messageIdsFor(`
        const name = "@/lib/x";
        async function load() {
          return import(name);
        }
      `),
    ).resolves.toEqual(["dynamicSpecifier"]);
  });

  it("só se aplica a arquivos de teste", async () => {
    await expect(
      messageIdsFor(
        `export async function load() { return import("@/lib/x"); }`,
        "src/lib/lazy.ts",
      ),
    ).resolves.toEqual([]);
    await expect(
      messageIdsFor(
        `export async function load() { return import("@/lib/x"); }`,
        "src/components/__tests__/Example.test.tsx",
      ),
    ).resolves.toEqual(["coldImport"]);
  });
});

// A regra de aquecimento do jsdom tem os testes de comportamento em
// test-jsdom-warm-up.test.ts, só com ela e sem esta config. Aqui fica o que
// depende de eslint.config.mjs, porque este arquivo já paga a carga dele no
// beforeAll acima: a regra ligada nos arquivos de teste, e só neles, e o import
// só de tipo, que pede o parser de TypeScript da config.
describe("regra de aquecimento do jsdom na config do ESLint", () => {
  const warmUpRuleId = `test-jsdom-warm-up/${WARM_UP_RULE_NAME}`;
  // Montado por partes, pelo mesmo motivo de test-jsdom-warm-up.test.ts: o
  // literal inteiro faria este arquivo rodar em jsdom.
  const jsdom = `// @vitest-${"environment"} jsdom\n`;

  // A severidade entra no resultado porque o lint-types não passa
  // --max-warnings: com a regra rebaixada para "warn", o hook sairia verde.
  async function warmUpMessageIds(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return (
      result?.messages
        .filter((message) => message.ruleId === warmUpRuleId)
        .map((message) => `${message.messageId}:${message.severity}`) ?? []
    );
  }

  it("liga a regra nos arquivos de teste e só neles", async () => {
    const code = `${jsdom}import { render } from "@testing-library/react";\nrender(null);`;
    await expect(
      warmUpMessageIds(code, "src/components/__tests__/Example.test.tsx"),
    ).resolves.toEqual(["missingWarmUp:2"]);
    await expect(warmUpMessageIds(code, "src/lib/helper.tsx")).resolves.toEqual([]);
  });

  it("não conta import só de tipo do render", async () => {
    await expect(
      warmUpMessageIds(
        `${jsdom}
        import { type render } from "@testing-library/react";
        import type { render as r } from "@testing-library/react";
        let renderizar: typeof render | typeof r;
        `,
        "src/components/__tests__/Example.test.tsx",
      ),
    ).resolves.toEqual([]);
  });
});
