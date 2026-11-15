import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { onRequestError } from "@/instrumentation";

type Context = Parameters<typeof onRequestError>[2];

const request = {
  path: "/projects/p1/config/general?__clerk_handshake=tok-secreto",
  method: "POST",
  headers: { cookie: "__session=segredo", authorization: "Bearer jwt" },
};
const context: Context = {
  routerKind: "App Router",
  routePath: "/(app)/projects/[id]/config/general",
  routeType: "action",
  renderSource: "react-server-components-payload",
  revalidateReason: undefined,
};

describe("onRequestError (#653)", () => {
  let consoleError: MockInstance<typeof console.error>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("loga numa linha só, com o código que a usuária vê, o stack completo e nada de headers ou query string", async () => {
    // O erro como o hook o recebe numa Server Action: o original, com o digest
    // que o Next carimbou e que também vai para o cliente (lá vira "1bkm1w6").
    const err = Object.assign(new Error("column responses.foo does not exist"), {
      digest: "2876531478",
    });
    err.stack = "Error: column responses.foo does not exist\n    at updateProject (actions/projects.ts:42:11)";

    await onRequestError(err, request, context);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      `[erro 1bkm1w6] ${JSON.stringify({
        routeType: "action",
        routePath: "/(app)/projects/[id]/config/general",
        method: "POST",
        path: "/projects/p1/config/general",
        message: "column responses.foo does not exist",
        stack: err.stack,
      })}`,
    );
  });

  it("erro sem digest numérico (controle do Next) não ganha linha própria", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/x;307;",
    });
    await onRequestError(redirect, request, context);
    await onRequestError(new Error("sem digest"), request, context);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
