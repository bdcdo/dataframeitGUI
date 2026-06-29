// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { fetchFastAPI } = vi.hoisted(() => ({ fetchFastAPI: vi.fn() }));
const { getToken } = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<string | null> => "tok-123"),
}));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("@/lib/api", () => ({
  fetchFastAPI,
  // Réplica do real: busca o token do template "supabase" e lança se vier nulo.
  requireSupabaseToken: async (
    gt: (opts: { template: string }) => Promise<string | null>,
  ) => {
    const t = await gt({ template: "supabase" });
    if (!t) throw new Error("MissingAuthTokenError");
    return t;
  },
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
    // Token buscado com o template "supabase" (não o de sessão default)...
    expect(getToken).toHaveBeenCalledWith({ template: "supabase" });
    // ...e repassado como 3º argumento (Authorization: Bearer) ao fetch.
    const [path, opts, token] = fetchFastAPI.mock.calls[0];
    expect(path).toBe("/api/llm/run");
    expect(opts).toMatchObject({ method: "POST" });
    expect(token).toBe("tok-123");
  });

  it("mostra erro acionável quando o token vem nulo (template/sessão)", async () => {
    getToken.mockResolvedValueOnce(null);
    render(<RunLlmButton projectId="p1" documentId="d1" canRunLlm />);

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Falha fechada antes do request: fetchFastAPI nem chega a ser chamado.
    expect(fetchFastAPI).not.toHaveBeenCalled();
  });
});
