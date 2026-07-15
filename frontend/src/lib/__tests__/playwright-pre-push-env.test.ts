import { describe, expect, it } from "vitest";
import {
  assertRequiredPrePushEnv,
  requiredPrePushEnv,
} from "../../../playwright-pre-push-env";

const completeRequiredEnv = Object.fromEntries(
  requiredPrePushEnv.map((name) => [name, "configured"]),
);

describe("assertRequiredPrePushEnv", () => {
  it("deriva as nove variáveis obrigatórias dos exemplos canônicos", () => {
    expect(requiredPrePushEnv).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "E2E_COORDINATOR_EMAIL",
      "E2E_MEMBER_EMAIL",
      "E2E_PROJECT_ID",
      "E2E_LOTTERY_PROJECT_ID",
    ]);
  });

  it("permite o pre-push sem a credencial opcional de master", () => {
    expect(() => assertRequiredPrePushEnv(completeRequiredEnv)).not.toThrow();
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
