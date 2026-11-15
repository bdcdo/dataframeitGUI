import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll } from "vitest";

// Setup comum dos testes de regra de lint em src/tooling/__tests__/.

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

/** ESLint com uma config do frontend (ex.: "eslint.config.mjs"). */
export function frontendEslint(configFile: string): ESLint {
  return new ESLint({ cwd: frontendRoot, overrideConfigFile: configFile });
}

/**
 * Lint de fixture filtrado por uma regra. Fixture que não parseia, cujo
 * caminho o ESLint ignora ou que nenhum bloco da config cobre reprova em vez
 * de devolver lista vazia, que passaria por "a regra aceitou". Os três casos
 * chegam como mensagem sem `ruleId`, como o aviso de eslint-disable sem uso,
 * que também reprova: fixture não precisa dele.
 */
export function ruleLinter(
  eslint: ESLint,
  ruleId: string,
  defaultFilePath: string,
) {
  async function messagesFor(code: string, filePath = defaultFilePath) {
    const [result] = await eslint.lintText(code, { filePath });
    const notLinted = result?.messages.find((message) => message.ruleId === null);
    if (notLinted) {
      throw new Error(`fixture não foi lintada: ${notLinted.message}`);
    }
    return result?.messages.filter((message) => message.ruleId === ruleId) ?? [];
  }

  async function messageIdsFor(code: string, filePath?: string) {
    return (await messagesFor(code, filePath)).map(
      (message) => message.messageId,
    );
  }

  /**
   * Registra um beforeAll que paga a carga a frio da config. Chame no topo do
   * arquivo, para cobrir todos os describes. O primeiro lintText carrega a
   * config e todo o grafo de plugins do eslint-config-next; os seguintes
   * reaproveitam o cache da instância. Sozinha, a carga leva perto de 1 s contra
   * 5 ms de uma chamada quente, mas com os workers da suíte disputando a CPU
   * passa de 5 s e estourava o timeout de qualquer teste que fosse o primeiro.
   * No hook, com prazo próprio, ela deixa de contar contra os testes, sem mexer
   * no timeout global. O prazo tem folga larga porque a carga fria chegou a 20 s
   * com o arquivo isolado e load 65.
   */
  function warmUp(): void {
    beforeAll(async () => {
      await eslint.lintText("export {};", { filePath: defaultFilePath });
    }, 60_000);
  }

  return { messagesFor, messageIdsFor, warmUp };
}
