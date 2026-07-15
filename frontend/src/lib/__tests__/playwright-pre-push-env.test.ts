import { describe, expect, it } from "vitest";
import {
  assertRequiredPrePushEnv,
  prePushEnv,
} from "../../../playwright-pre-push-env";

const completeRequiredEnv = {
  CLERK_SECRET_KEY: "configured",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "configured",
  E2E_COORDINATOR_EMAIL: "configured",
  E2E_MEMBER_EMAIL: "configured",
  E2E_PROJECT_ID: "configured",
  E2E_LOTTERY_PROJECT_ID: "configured",
} satisfies Record<(typeof prePushEnv.required)[number], string>;

describe("assertRequiredPrePushEnv", () => {
  it("permite o pre-push sem a credencial opcional de master", () => {
    expect(prePushEnv.required).not.toContain("E2E_MASTER_EMAIL");
    expect(prePushEnv.optional).toContain("E2E_MASTER_EMAIL");
    expect(completeRequiredEnv).not.toHaveProperty("E2E_MASTER_EMAIL");
    expect(() => assertRequiredPrePushEnv(completeRequiredEnv)).not.toThrow();
  });

  it("mantém as classificações obrigatória e opcional disjuntas", () => {
    const classifiedNames = [...prePushEnv.required, ...prePushEnv.optional];

    expect(new Set(classifiedNames).size).toBe(classifiedNames.length);
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
