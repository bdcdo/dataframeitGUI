import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertRequiredPrePushEnv,
  requiredPrePushEnv,
} from "../../../playwright-pre-push-env";
import {
  applyEnvironment,
  readOptionalEnvironmentFile,
} from "../../../scripts/worktree-env/env-contract.mjs";

const completeRequiredEnv = Object.fromEntries(
  requiredPrePushEnv.map((name) => [name, "configured"]),
);

describe("assertRequiredPrePushEnv", () => {
  it("deriva as dez variáveis obrigatórias dos exemplos canônicos", () => {
    expect(requiredPrePushEnv).toEqual(
      [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        "CLERK_SECRET_KEY",
        "E2E_COORDINATOR_EMAIL",
        "E2E_MEMBER_EMAIL",
        "E2E_PROJECT_ID",
        "E2E_LOTTERY_PROJECT_ID",
        // coding-save.smoke.spec.ts — projeto dedicado do smoke de salvamento
        "E2E_CODING_PROJECT_ID",
      ].sort(),
    );
  });

  it("permite o pre-push sem a credencial opcional de master", () => {
    expect(() => assertRequiredPrePushEnv(completeRequiredEnv)).not.toThrow();
  });

  it("mantém variável exportada e permite override explícito do E2E", () => {
    const environment = { CLERK_SECRET_KEY: "shell" };

    applyEnvironment(environment, { CLERK_SECRET_KEY: "local" });
    expect(environment.CLERK_SECRET_KEY).toBe("shell");

    applyEnvironment(
      environment,
      { CLERK_SECRET_KEY: "e2e" },
      { override: true },
    );
    expect(environment.CLERK_SECRET_KEY).toBe("e2e");
  });

  it("tolera arquivo local ausente no modo manual", () => {
    expect(
      readOptionalEnvironmentFile(
        join(tmpdir(), "dataframeit-env-file-that-does-not-exist"),
      ),
    ).toEqual({});
  });

  it("propaga erro de leitura diferente de arquivo ausente", () => {
    expect(() => readOptionalEnvironmentFile(tmpdir())).toThrow();
  });

  it("rejeita valor obrigatório composto somente por espaços", () => {
    expect(() =>
      assertRequiredPrePushEnv({
        ...completeRequiredEnv,
        CLERK_SECRET_KEY: "   ",
      }),
    ).toThrow("Faltando: CLERK_SECRET_KEY");
  });

  it.each(requiredPrePushEnv)(
    "falha fechado quando falta a variável obrigatória %s",
    (missingName) => {
      const incompleteEnv = {
        ...completeRequiredEnv,
        [missingName]: undefined,
      };

      expect(() => assertRequiredPrePushEnv(incompleteEnv)).toThrow(
        `Faltando: ${missingName}`,
      );
    },
  );
});
