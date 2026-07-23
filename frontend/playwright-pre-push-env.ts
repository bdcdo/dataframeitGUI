import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  environmentFiles,
  hasConfiguredEnvironmentValue,
  requiredEnvironmentNames,
} from "./scripts/worktree-env/env-contract.mjs";

export const requiredPrePushEnv = requiredEnvironmentNames(__dirname);

/**
 * Arquivos de ambiente cujo symlink aponta para um alvo que não existe mais.
 *
 * A causa dominante é um link para outra worktree, removida depois. Sem esta
 * checagem a única pista é "faltando <N> variáveis", que manda investigar
 * credencial, tenant e porta — três saltos longe de um link pendente. Este é o
 * diagnóstico, não o gate: o gate continua sendo a ausência das variáveis.
 */
export function danglingEnvironmentLinks(
  frontendDirectory: string = __dirname,
): { file: string; target: string }[] {
  return environmentFiles.flatMap((filename) => {
    const path = join(frontendDirectory, filename);
    let entry;
    try {
      entry = lstatSync(path);
    } catch {
      return [];
    }
    if (!entry.isSymbolicLink() || existsSync(path)) return [];
    return [{ file: filename, target: readlinkSync(path) }];
  });
}

export function assertRequiredPrePushEnv(
  env: Readonly<Record<string, string | undefined>>,
  frontendDirectory: string = __dirname,
): void {
  const missing = requiredPrePushEnv.filter(
    (name) => !hasConfiguredEnvironmentValue(env[name]),
  );

  if (missing.length === 0) return;

  const dangling = danglingEnvironmentLinks(frontendDirectory);

  throw new Error(
    [
      "e2e-smoke pre-push sem variáveis obrigatórias.",
      `Faltando: ${missing.join(", ")}`,
      ...(dangling.length > 0
        ? [
            "",
            "Causa provável — symlink de ambiente apontando para alvo inexistente:",
            ...dangling.map(({ file, target }) => `  ${file} -> ${target}`),
            "Repare com: ./frontend/scripts/worktree-env/bootstrap.sh",
          ]
        : [
            "Configure as variáveis não comentadas de frontend/.env.local.example e frontend/.env.e2e.example nos respectivos arquivos locais.",
            "Numa worktree nova: ./frontend/scripts/worktree-env/bootstrap.sh",
          ]),
      "Bypass intencional neste push: SKIP=e2e-smoke git push",
    ].join("\n"),
  );
}
