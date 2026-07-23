// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const { fetchFastAPI } = vi.hoisted(() => ({ fetchFastAPI: vi.fn() }));
const { getToken } = vi.hoisted(() => ({
  getToken: vi.fn(async () => "test-token"),
}));
const { cleanupStaleLlmRuns, getRunningLlmJob } = vi.hoisted(() => ({
  cleanupStaleLlmRuns: vi.fn(async () => ({ cleaned: 0 })),
  getRunningLlmJob: vi.fn(),
}));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

// requireSupabaseToken delega ao getToken passado (réplica do real): busca o
// token do template "supabase" e lança se vier nulo.
vi.mock("@/lib/api", () => ({
  fetchFastAPI,
  requireSupabaseToken: async (gt: () => Promise<string | null>) => {
    const t = await gt();
    if (!t) throw new Error("MissingAuthTokenError");
    return t;
  },
}));
vi.mock("@/actions/llm", () => ({ cleanupStaleLlmRuns, getRunningLlmJob }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@/lib/scroll", () => ({ getScrollBehavior: () => "auto" }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken }),
}));

import { useLlmRunProgress } from "../useLlmRunProgress";

function statusRes(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    phase: "idle",
    progress: 5,
    total: 5,
    errors: [],
    eta_seconds: null,
    current_batch: 0,
    total_batches: 0,
    error_traceback: null,
    error_type: null,
    error_line: null,
    error_column: null,
    pydantic_code: null,
    processed_complete: 5,
    processed_partial: 0,
    processed_empty: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useLlmRunProgress", () => {
  it("não religa polling quando não há run em andamento", async () => {
    getRunningLlmJob.mockResolvedValue(null);
    const { result } = renderHook(() => useLlmRunProgress("p1", null));

    await waitFor(() => expect(getRunningLlmJob).toHaveBeenCalledWith("p1"));
    expect(cleanupStaleLlmRuns).toHaveBeenCalledWith("p1");
    expect(result.current.status).toBe("idle");
    expect(fetchFastAPI).not.toHaveBeenCalled();
  });

  it("start() dispara o polling e conclui ao receber status completed", async () => {
    getRunningLlmJob.mockResolvedValue(null);
    fetchFastAPI.mockResolvedValue(statusRes({ status: "completed" }));
    const { result } = renderHook(() => useLlmRunProgress("p1", null));
    await waitFor(() => expect(getRunningLlmJob).toHaveBeenCalled());

    act(() => result.current.start("job-1"));

    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(fetchFastAPI).toHaveBeenCalledWith(
      "/api/llm/status/job-1",
      undefined,
      "test-token",
    );
    expect(result.current.progress).toBe(5);
    expect(toastSuccess).toHaveBeenCalledWith("LLM concluído!");
    // refresh: uma vez no start (badge) + uma na conclusão.
    expect(refresh).toHaveBeenCalled();
  });

  it("popula errorInfo e toast em status de erro do backend", async () => {
    getRunningLlmJob.mockResolvedValue(null);
    fetchFastAPI.mockResolvedValue(
      statusRes({ status: "error", errors: ["explodiu"], error_type: "ValueError" }),
    );
    const { result } = renderHook(() => useLlmRunProgress("p1", "code-x"));
    await waitFor(() => expect(getRunningLlmJob).toHaveBeenCalled());

    act(() => result.current.start("job-2"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorInfo).toMatchObject({
      message: "explodiu",
      type: "ValueError",
    });
    expect(toastError).toHaveBeenCalled();

    act(() => result.current.dismissError());
    expect(result.current.errorInfo).toBeNull();
  });

  it("não trata uma falha transitória isolada como terminal", async () => {
    // 1ª tick falha (blip), 2ª resolve: o polling se recupera sem mostrar erro.
    getRunningLlmJob.mockResolvedValue(null);
    fetchFastAPI
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue(statusRes({ status: "completed" }));
    const { result } = renderHook(() => useLlmRunProgress("p1", null));
    await waitFor(() => expect(getRunningLlmJob).toHaveBeenCalled());

    act(() => result.current.start("job-x"));

    await waitFor(() => expect(result.current.status).toBe("completed"), {
      timeout: 5000,
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("erra após MAX falhas consecutivas no polling", async () => {
    getRunningLlmJob.mockResolvedValue(null);
    fetchFastAPI.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useLlmRunProgress("p1", null));
    await waitFor(() => expect(getRunningLlmJob).toHaveBeenCalled());

    act(() => result.current.start("job-3"));

    await waitFor(() => expect(result.current.status).toBe("error"), {
      timeout: 7000,
    });
    expect(result.current.errorInfo).toMatchObject({
      message: "offline",
      type: "NetworkError",
    });
  });

  it("retoma uma run em andamento ao montar com token do template supabase", async () => {
    getRunningLlmJob.mockResolvedValue({ job_id: "resumed" });
    fetchFastAPI.mockResolvedValue(statusRes({ status: "completed" }));
    renderHook(() => useLlmRunProgress("p1", null));

    await waitFor(() =>
      expect(fetchFastAPI).toHaveBeenCalledWith(
        "/api/llm/status/resumed",
        undefined,
        "test-token",
      ),
    );
    // Session token, sem template (o JWT template legado saiu — #348).
    expect(getToken).toHaveBeenCalledWith();
  });
});
