import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { RULE_NAME } from "../../../eslint-rules/test-cold-imports.mjs";

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
        const { other } = await import("@/lib/na-coleta");
        async function load() {
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
