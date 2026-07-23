// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
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
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));

import { RunLlmButton } from "../RunLlmButton";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
