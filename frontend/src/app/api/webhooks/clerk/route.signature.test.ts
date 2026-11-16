import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

// Contrato com a biblioteca svix REAL, sem dublê: route.test.ts substitui o
// `Webhook` por um mock, e um mock não percebe quando a biblioteca muda de
// contrato. Foi o que aconteceu na 2.x: `verify` deixou de fazer o parse do
// JSON e passou a devolver `undefined`, e a rota, que lia o evento do retorno,
// quebrava em todo `user.*` enquanto o mock antigo seguia verde.

const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

const hoisted = vi.hoisted(() => ({
  headers: new Headers(),
  reconcile: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/lib/clerk-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clerk-sync")>()),
  reconcileClerkUserAccess: (...args: unknown[]) => hoisted.reconcile(...args),
  revokeClerkUserAccess: (...args: unknown[]) => hoisted.revoke(...args),
}));

vi.mock("next/headers", () => ({
  headers: async () => hoisted.headers,
}));

import { POST } from "@/app/api/webhooks/clerk/route";

function signedRequest(body: string, signWith = SECRET): Request {
  const msgId = "msg_real_1";
  const timestamp = new Date();
  hoisted.headers = new Headers({
    "svix-id": msgId,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(signWith).sign(msgId, timestamp, body),
  });
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    body,
  });
}

describe("POST /api/webhooks/clerk com svix real", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    hoisted.reconcile.mockReset().mockResolvedValue(undefined);
    hoisted.revoke.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reconcilia o usuário de um user.created com assinatura válida", async () => {
    const body = JSON.stringify({
      type: "user.created",
      data: { id: "clerk_real_1" },
    });

    const response = await POST(signedRequest(body));

    expect(response.status).toBe(200);
    expect(hoisted.reconcile).toHaveBeenCalledWith("clerk_real_1");
  });

  it("revoga o acesso de um user.deleted com assinatura válida", async () => {
    const body = JSON.stringify({
      type: "user.deleted",
      data: { id: "clerk_real_2", deleted: true },
    });

    const response = await POST(signedRequest(body));

    expect(response.status).toBe(200);
    expect(hoisted.revoke).toHaveBeenCalledWith("clerk_real_2");
  });

  it("recusa assinatura feita com outro segredo sem tocar no acesso", async () => {
    const body = JSON.stringify({
      type: "user.created",
      data: { id: "clerk_real_3" },
    });
    const otherSecret = `whsec_${Buffer.from("fedcba9876543210fedcba9876543210").toString("base64")}`;

    const response = await POST(signedRequest(body, otherSecret));

    expect(response.status).toBe(400);
    expect(hoisted.reconcile).not.toHaveBeenCalled();
  });

  it("recusa corpo alterado depois da assinatura: o evento lido é o verificado", async () => {
    const signed = JSON.stringify({
      type: "user.created",
      data: { id: "clerk_real_4" },
    });
    const tampered = JSON.stringify({
      type: "user.created",
      data: { id: "clerk_intruso" },
    });
    const request = signedRequest(signed);

    const response = await POST(
      new Request(request.url, { method: "POST", body: tampered }),
    );

    expect(response.status).toBe(400);
    expect(hoisted.reconcile).not.toHaveBeenCalled();
  });
});
