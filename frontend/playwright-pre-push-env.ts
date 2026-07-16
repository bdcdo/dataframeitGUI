export const requiredPrePushEnv = [
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "E2E_COORDINATOR_EMAIL",
  "E2E_MEMBER_EMAIL",
  "E2E_PROJECT_ID",
  "E2E_LOTTERY_PROJECT_ID",
] as const;

export function assertRequiredPrePushEnv(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const missing = requiredPrePushEnv.filter((name) => !env[name]);

  if (missing.length === 0) return;

  throw new Error(
    [
      "e2e-smoke pre-push sem variáveis obrigatórias.",
      `Faltando: ${missing.join(", ")}`,
      "Configure frontend/.env.local com as chaves Clerk e copie frontend/.env.e2e.example para frontend/.env.e2e preenchendo os usuários/projetos de teste.",
      "Bypass intencional neste push: SKIP=e2e-smoke git push",
    ].join("\n"),
  );
}
