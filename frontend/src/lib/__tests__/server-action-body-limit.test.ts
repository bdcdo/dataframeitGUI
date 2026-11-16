import { describe, expect, it } from "vitest";
import {
  SERVER_ACTION_BODY_LIMIT,
  SERVER_ACTION_BODY_LIMIT_BYTES,
  serverActionTooLarge,
} from "@/lib/server-action-body-limit";
import { isPayloadTooLarge } from "@/lib/upload-chunking";
import nextConfig from "../../../next.config";

function actionRequest(headers: Record<string, string>, method = "POST") {
  return new Request("https://dataframeit.com.br/projects/p1/documents", {
    method,
    headers: { "next-action": "abc123", ...headers },
  });
}

describe("serverActionTooLarge", () => {
  it("recusa com 413 text/plain a action acima do teto, e o texto é o que o cliente reconhece", async () => {
    const response = serverActionTooLarge(
      actionRequest({ "content-length": String(SERVER_ACTION_BODY_LIMIT_BYTES + 1) }),
    );
    expect(response?.status).toBe(413);
    expect(response?.headers.get("content-type")).toBe("text/plain");
    // O cliente do Next transforma o texto da resposta na mensagem do erro.
    expect(isPayloadTooLarge(new Error(await response!.text()))).toBe(true);
  });

  it("deixa passar o que está no teto, o que não declara tamanho e o que não é action", () => {
    expect(
      serverActionTooLarge(
        actionRequest({ "content-length": String(SERVER_ACTION_BODY_LIMIT_BYTES) }),
      ),
    ).toBeNull();
    expect(serverActionTooLarge(actionRequest({}))).toBeNull();
    expect(
      serverActionTooLarge(
        new Request("https://dataframeit.com.br/api/webhooks/clerk", {
          method: "POST",
          headers: { "content-length": String(SERVER_ACTION_BODY_LIMIT_BYTES * 2) },
        }),
      ),
    ).toBeNull();
  });

  it("o teto é o mesmo que o next.config passa ao Next", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe(SERVER_ACTION_BODY_LIMIT);
    expect(SERVER_ACTION_BODY_LIMIT_BYTES).toBe(10 * 1024 * 1024);
  });
});
