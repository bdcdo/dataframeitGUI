import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reconcile: vi.fn(),
  revoke: vi.fn(),
}));

// importOriginal preserva a classe REAL de ClerkIdentityConflictError: a rota
// decide o status por `instanceof`, então uma classe dublê faria a checagem
// passar por construção do teste, sem provar nada sobre o código.
vi.mock("@/lib/clerk-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clerk-sync")>()),
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

// O dublê do svix imita a 2.x: `verify` só autentica e devolve undefined, e a
// rota lê o evento do corpo. O contrato com a biblioteca real está em
// route.signature.test.ts.
vi.mock("svix", () => ({
  Webhook: class {
    verify() {}
  },
}));

import { POST } from "@/app/api/webhooks/clerk/route";
import { ClerkIdentityConflictError } from "@/lib/clerk-sync";

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

function webhookRequest(event: unknown = userEvent()) {
  return new Request("http://localhost", {
    body: JSON.stringify(event),
    method: "POST",
  });
}

beforeEach(() => {
  process.env.CLERK_WEBHOOK_SECRET = "test-secret";
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
    const event = userEvent("user.updated");

    const firstResponse = await POST(webhookRequest(event));
    const retryResponse = await POST(webhookRequest(event));

    expect(firstResponse.status).toBe(200);
    expect(retryResponse.status).toBe(200);
    expect(hoisted.reconcile).toHaveBeenCalledTimes(2);
    expect(hoisted.reconcile).toHaveBeenNthCalledWith(2, "clerk_1");
  });

  it.each(["user.created", "user.updated"] as const)(
    "faz ACK 200 em %s quando o estado atual ainda não tem identidade utilizável",
    async (eventType) => {
      const event = userEvent(eventType, "unverified");
      hoisted.reconcile.mockResolvedValueOnce(null);

      const response = await POST(webhookRequest(event));

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("OK");
      expect(hoisted.reconcile).toHaveBeenCalledWith("clerk_1");
    },
  );

  it("payload atrasado não vira autoridade sobre e-mails nem metadata", async () => {
    const event = userEvent(
      "user.updated",
      "verified",
      "unverified",
      "accountUid",
    );

    const response = await POST(webhookRequest(event));

    expect(response.status).toBe(200);
    expect(hoisted.reconcile).toHaveBeenCalledWith("clerk_1");
  });

  it("user.deleted revoga mapping e aliases sem tentar reler a conta", async () => {
    const event = userEvent("user.deleted");

    const response = await POST(webhookRequest(event));

    expect(response.status).toBe(200);
    expect(hoisted.revoke).toHaveBeenCalledWith("clerk_1");
    expect(hoisted.reconcile).not.toHaveBeenCalled();
  });

  it("falha ao revogar user.deleted responde 500 para retry", async () => {
    const event = userEvent("user.deleted");
    hoisted.revoke.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(webhookRequest(event));

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

  // O par do teste acima: o Svix trata todo não-2xx como falha e reentrega em
  // escada. Para um conflito estrutural — que por definição não muda com
  // insistência — isso queimaria as tentativas e marcaria o endpoint como
  // falhando, afogando o sinal de uma indisponibilidade real.
  it("conflito estrutural de identidade responde 200: retry não resolveria", async () => {
    hoisted.reconcile.mockRejectedValueOnce(
      new ClerkIdentityConflictError("Este e-mail já pertence a uma conta ativa"),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      "Access conflict: retry will not resolve",
    );
  });

  it("user.deleted sem id é no-op 200, não retry de um evento sem ação possível", async () => {
    const event = {
      type: "user.deleted",
      data: {},
    };

    const response = await POST(webhookRequest(event));

    expect(response.status).toBe(200);
    expect(hoisted.revoke).not.toHaveBeenCalled();
  });
});
