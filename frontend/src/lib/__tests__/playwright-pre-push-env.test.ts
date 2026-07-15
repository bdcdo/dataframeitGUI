import { describe, expect, it } from "vitest";
import {
  assertRequiredPrePushEnv,
  requiredPrePushEnv,
} from "../../../playwright-pre-push-env";

const completeRequiredEnv = {
  CLERK_SECRET_KEY: "configured",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "configured",
  E2E_COORDINATOR_EMAIL: "configured",
  E2E_MEMBER_EMAIL: "configured",
  E2E_PROJECT_ID: "configured",
  E2E_LOTTERY_PROJECT_ID: "configured",
} satisfies Record<(typeof requiredPrePushEnv)[number], string>;

describe("assertRequiredPrePushEnv", () => {
  it("permite o pre-push sem a credencial opcional de master", () => {
    expect(() => assertRequiredPrePushEnv(completeRequiredEnv)).not.toThrow();
  });

  it("falha fechado quando falta uma credencial obrigatória", () => {
    const envWithoutMember = {
      ...completeRequiredEnv,
      E2E_MEMBER_EMAIL: undefined,
    };

    expect(() => assertRequiredPrePushEnv(envWithoutMember)).toThrow(
      /Faltando: E2E_MEMBER_EMAIL/,
    );
  });
});
