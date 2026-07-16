import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reconcile: vi.fn(),
  revoke: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/clerk-sync", () => ({
  reconcileClerkUserAccess: (...args: unknown[]) => hoisted.reconcile(...args),
  revokeClerkUserAccess: (...args: unknown[]) => hoisted.revoke(...args),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "svix-id": "msg_1",
      "svix-timestamp": "123",
      "svix-signature": "signature",
    }),
}));

vi.mock("svix", () => ({
  Webhook: class {
    verify(...args: unknown[]) {
      return hoisted.verify(...args);
    }
  },
}));

import { POST } from "@/app/api/webhooks/clerk/route";

function userEvent(
  type: "user.created" | "user.updated" | "user.deleted" = "user.created",
  verificationStatus: "verified" | "unverified" = "verified",
  secondaryVerificationStatus: "verified" | "unverified" = "verified",
  metadataUid: string | null = null,
) {
  return {
    type,
    data: {
      id: "clerk_1",
      primary_email_address_id: "email_primary",
      email_addresses: [
        {
          id: "email_secondary",
          email_address: "secundario@exemplo.com",
          verification: { status: secondaryVerificationStatus },
        },
        {
          id: "email_primary",
          email_address: "pessoa@exemplo.com",
          verification: { status: verificationStatus },
        },
      ],
      public_metadata: metadataUid ? { supabase_uid: metadataUid } : {},
      first_name: "Pessoa",
      last_name: "Exemplo",
    },
  };
}

function webhookRequest() {
  return new Request("http://localhost", { body: "{}", method: "POST" });
}

beforeEach(() => {
  process.env.CLERK_WEBHOOK_SECRET = "test-secret";
  hoisted.verify.mockReset();
  hoisted.verify.mockReturnValue(userEvent());
  hoisted.reconcile.mockReset();
  hoisted.reconcile.mockResolvedValue("accountUid");
  hoisted.revoke.mockReset();
  hoisted.revoke.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook Clerk — reconciliação de acesso", () => {
  it("usa somente o ID do evento e relê o estado atual antes de responder 200", async () => {
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(hoisted.reconcile).toHaveBeenCalledWith("clerk_1");
  });

  it("reprocessa user.updated pela mesma reconciliação idempotente", async () => {
    hoisted.verify.mockReturnValue(userEvent("user.updated"));

    const firstResponse = await POST(webhookRequest());
    const retryResponse = await POST(webhookRequest());

    expect(firstResponse.status).toBe(200);
    expect(retryResponse.status).toBe(200);
    expect(hoisted.reconcile).toHaveBeenCalledTimes(2);
    expect(hoisted.reconcile).toHaveBeenNthCalledWith(2, "clerk_1");
  });

  it.each(["user.created", "user.updated"] as const)(
    "faz ACK 200 em %s quando o estado atual ainda não tem identidade utilizável",
    async (eventType) => {
      hoisted.verify.mockReturnValue(userEvent(eventType, "unverified"));
      hoisted.reconcile.mockResolvedValueOnce(null);

      const response = await POST(webhookRequest());

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("OK");
      expect(hoisted.reconcile).toHaveBeenCalledWith("clerk_1");
    },
  );

  it("payload atrasado não vira autoridade sobre e-mails nem metadata", async () => {
    hoisted.verify.mockReturnValue(
      userEvent("user.updated", "verified", "unverified", "accountUid"),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(hoisted.reconcile).toHaveBeenCalledWith("clerk_1");
  });

  it("user.deleted revoga mapping e aliases sem tentar reler a conta", async () => {
    hoisted.verify.mockReturnValue(userEvent("user.deleted"));

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(hoisted.revoke).toHaveBeenCalledWith("clerk_1");
    expect(hoisted.reconcile).not.toHaveBeenCalled();
  });

  it("falha ao revogar user.deleted responde 500 para retry", async () => {
    hoisted.verify.mockReturnValue(userEvent("user.deleted"));
    hoisted.revoke.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
  });

  it("falha de resolução ou ativação responde 500 para o provedor repetir", async () => {
    hoisted.reconcile.mockRejectedValueOnce(
      new Error("falha ao ativar membro canônico"),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Access reconciliation failed");
  });
});
