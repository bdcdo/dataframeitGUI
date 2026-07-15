import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const environmentExamples = [".env.local.example", ".env.e2e.example"];

export const requiredPrePushEnv = environmentExamples.flatMap((filename) =>
  Object.keys(
    parse(readFileSync(resolve(__dirname, filename), { encoding: "utf8" })),
  ),
);

export function assertRequiredPrePushEnv(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const missing = requiredPrePushEnv.filter((name) => !env[name]);

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
