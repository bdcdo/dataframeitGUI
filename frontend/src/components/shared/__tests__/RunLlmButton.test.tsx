// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { fetchFastAPI } = vi.hoisted(() => ({ fetchFastAPI: vi.fn() }));
const { getToken } = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<string | null> => "tok-123"),
}));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

// requireSupabaseToken real (via importOriginal): o teste do token nulo prova a
// falha-fechada do helper de verdade, não de uma réplica. Só a fronteira externa
// (fetchFastAPI) é mockada; getToken já é dublê via o mock de @clerk/nextjs.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchFastAPI,
}));
// A conta que o Clerk expõe no browser: a metadata dela separa o acesso ainda
// não concluído (sem `supabase_uid`) da instância sem os custom claims (#487).
const { clerkUser } = vi.hoisted(() => ({
  clerkUser: { publicMetadata: {} as { supabase_uid?: string } },
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken }),
  useUser: () => ({ user: clerkUser }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));

import { UNLINKED_CLAIMS, sessionTokenWith } from "@/test-utils/session-token";
import { RunLlmButton } from "../RunLlmButton";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  getToken.mockImplementation(async () => "tok-123");
  clerkUser.publicMetadata = {};
});

describe("RunLlmButton", () => {
  it("não renderiza nada para quem não é coordenador (canRunLlm=false)", () => {
    const { container } = render(
      <RunLlmButton projectId="p1" documentId="d1" canRunLlm={false} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("dispara /api/llm/run com token do template supabase ao clicar", async () => {
    fetchFastAPI.mockResolvedValue({ job_id: "j1" });
    render(<RunLlmButton projectId="p1" documentId="d1" canRunLlm />);

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(fetchFastAPI).toHaveBeenCalled());
    // Session token, sem template: o JWT template legado saiu (#348). Passar um
    // `{ template }` aqui voltaria a gerar um token com `aud`, que o backend
    // (que agora valida `iss`) não espera mais.
    expect(getToken).toHaveBeenCalledWith();
    // ...e repassado como 3º argumento (Authorization: Bearer) ao fetch.
    const [path, opts, token] = fetchFastAPI.mock.calls[0];
    expect(path).toBe("/api/llm/run");
    expect(opts).toMatchObject({ method: "POST" });
    expect(token).toBe("tok-123");
    // Sem o prop, o body carrega impersonating:false — o backend não bloqueia.
    expect(JSON.parse(opts.body)).toMatchObject({ impersonating: false });
  });

  it("com impersonating=true, o body carrega o sinal para o interlock server-side", async () => {
    // O botão normalmente fica disabled na Comparação em somente-leitura; este
    // teste cobre o backstop: se a execução partir, o sinal viaja ao backend,
    // que recusa um master impersonando (issue #428).
    fetchFastAPI.mockResolvedValue({ job_id: "j1" });
    render(<RunLlmButton projectId="p1" documentId="d1" canRunLlm impersonating />);

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(fetchFastAPI).toHaveBeenCalled());
    const [, opts] = fetchFastAPI.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({ impersonating: true });
  });

  it("mostra erro acionável quando o token vem nulo (template/sessão)", async () => {
    getToken.mockResolvedValueOnce(null);
    render(<RunLlmButton projectId="p1" documentId="d1" canRunLlm />);

    await userEvent.click(screen.getByRole("button"));

    // Mensagem do MissingAuthTokenError real (via helper importOriginal) chega ao
    // toast; fixá-la fecha regressão silenciosa na causa acionável mostrada ao
    // usuário — não bastaria saber que "algum" toast de erro disparou.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("Sessão indisponível"),
      ),
    );
    // Falha fechada antes do request: fetchFastAPI nem chega a ser chamado.
    expect(fetchFastAPI).not.toHaveBeenCalled();
  });

  it("sessão sem o vínculo concluído: toast diz o que fazer e nada vai ao backend (#532)", async () => {
    // Payload só com os claims default do Clerk — sem `supabase_uid`.
    const unlinked = sessionTokenWith({ ...UNLINKED_CLAIMS, jti: "pendente" });
    getToken.mockResolvedValue(unlinked);
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RunLlmButton projectId="p1" documentId="d1" canRunLlm />);

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Seu acesso ainda não foi concluído. Recarregue a página para concluir o acesso.",
      ),
    );
    expect(fetchFastAPI).not.toHaveBeenCalled();
  });

  it("conta COM vínculo e token sem o claim: o request segue para o 503 do backend (#487)", async () => {
    // Instância Clerk sem os custom claims: dizer "conclua o acesso" a quem já
    // o concluiu esconderia a config quebrada. O backend é quem responde, alto.
    const unlinked = sessionTokenWith({ ...UNLINKED_CLAIMS, jti: "cutover" });
    getToken.mockResolvedValue(unlinked);
    clerkUser.publicMetadata = { supabase_uid: "11111111-1111-1111-1111-111111111111" };
    fetchFastAPI.mockRejectedValue(new Error("Autenticação mal configurada no servidor"));
    render(<RunLlmButton projectId="p1" documentId="d1" canRunLlm />);

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(fetchFastAPI).toHaveBeenCalled());
    expect(fetchFastAPI.mock.calls[0][2]).toBe(unlinked);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Autenticação mal configurada no servidor"),
    );
  });
});
