import {
  hasConfiguredEnvironmentValue,
  requiredEnvironmentNames,
} from "./scripts/worktree-env/env-contract.mjs";

export const requiredPrePushEnv = requiredEnvironmentNames(__dirname);

export function assertRequiredPrePushEnv(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const missing = requiredPrePushEnv.filter(
    (name) => !hasConfiguredEnvironmentValue(env[name]),
  );

  if (missing.length === 0) return;

  throw new Error(
    [
      "e2e-smoke pre-push sem variáveis obrigatórias.",
      `Faltando: ${missing.join(", ")}`,
      "Configure as variáveis não comentadas de frontend/.env.local.example e frontend/.env.e2e.example nos respectivos arquivos locais.",
      "Bypass intencional neste push: SKIP=e2e-smoke git push",
    ].join("\n"),
  );
}
