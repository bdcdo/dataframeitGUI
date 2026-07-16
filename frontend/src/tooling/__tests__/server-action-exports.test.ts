import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { RULE_NAME } from "../../../eslint-rules/server-action-exports.mjs";

const frontendRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ruleId = `server-actions/${RULE_NAME}`;
const eslint = new ESLint({
  cwd: frontendRoot,
  overrideConfigFile: "eslint.config.mjs",
});

async function messagesFor(
  code: string,
  filePath = "src/actions/example.ts",
) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((message) => message.ruleId === ruleId) ?? [];
}

describe('regra de exports em módulos "use server"', () => {
  it("permite funções async diretas e exports de tipo", async () => {
    await expect(
      messagesFor(`
        "use server";
        export async function declared() { return 1; }
        export const arrow = async () => 2;
        export const expression = async function () { return 3; };
        export const satisfying = (async () => 4) satisfies () => Promise<number>;
        export const instantiated = (async <T>(value: T) => value)<string>;
        export const asserted = (async () => 6) as () => Promise<number>;
        export const nonNull = (async () => 7)!;
        export const typeAsserted = <() => Promise<number>>(async () => 8);
        export default async function defaultAction() { return 5; }
        export type Result = { ok: boolean };
        export interface Options { enabled: boolean }
        export { type Result as PublicResult };
        export type { RemoteResult } from "./other";
        export type * from "./types";
      `),
    ).resolves.toEqual([]);

    await expect(
      messagesFor(`"use server"; export default interface Options {}`),
    ).resolves.toEqual([]);
  });

  // Assinaturas de overload e declaracoes ambientes sao `TSDeclareFunction`:
  // nao emitem valor, entao nao ha export de valor a bloquear. A implementacao
  // do overload e um statement proprio e continua sujeita a regra.
  it("permite overloads async e declarações ambientes", async () => {
    await expect(
      messagesFor(`
        "use server";
        export declare function ambient(): Promise<void>;
        export async function overloaded(value: string): Promise<number>;
        export async function overloaded(value: number): Promise<number>;
        export async function overloaded(value: string | number): Promise<number> {
          return Number(value);
        }
      `),
    ).resolves.toEqual([]);
  });

  it("aplica a regra a módulos .mts", async () => {
    await expect(
      messagesFor(
        `"use server";\nexport function syncAction() {}`,
        "src/actions/example.mts",
      ),
    ).resolves.toHaveLength(1);
  });

  it("ignora módulos sem a diretiva", async () => {
    await expect(
      messagesFor("export function ordinaryFunction() {}"),
    ).resolves.toEqual([]);
  });

  it.each([
    ["função síncrona", "export function sync() { return 1; }", "valueExport"],
    ["constante", "export const value = 1;", "valueExport"],
    ["arrow síncrona", "export const sync = () => 1;", "valueExport"],
    ["enum", "export enum Mode { Draft }", "valueExport"],
    ["binding mutável", "export let action = async () => 1;", "valueExport"],
    [
      "declarators mistos",
      "export const valid = async () => 1, invalid = () => 2;",
      "valueExport",
    ],
    [
      "async generator",
      "export async function* stream() { yield 1; }",
      "generatorExport",
    ],
    [
      "generator em const",
      "export const stream = async function* () { yield 1; };",
      "generatorExport",
    ],
  ])("bloqueia %s", async (_caseName, exported, expectedMessageId) => {
    const messages = await messagesFor(`"use server";\n${exported}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe(expectedMessageId);
  });

  it("bloqueia aliases, reexports e default de valor", async () => {
    const messages = await messagesFor(`
      "use server";
      const internal = async () => true;
      export { internal as publicAction };
      export * from "./other";
      export default 1;
    `);

    expect(messages.map((message) => message.messageId)).toEqual([
      "indirectExport",
      "indirectExport",
      "valueExport",
    ]);
  });

  it("orienta a correção conforme o tipo de export inválido", async () => {
    const [pureValue] = await messagesFor(`"use server";\nexport const n = 1;`);
    expect(pureValue?.message).toContain(
      "Mova valores puros para um módulo sem a diretiva",
    );

    const [alias] = await messagesFor(
      `"use server";\nconst internal = async () => 1;\nexport { internal };`,
    );
    expect(alias?.message).toContain(
      "Declare a função async diretamente neste módulo",
    );
  });
});
