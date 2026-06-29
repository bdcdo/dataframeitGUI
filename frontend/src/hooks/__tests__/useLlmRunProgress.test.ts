// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const { fetchFastAPI } = vi.hoisted(() => ({ fetchFastAPI: vi.fn() }));
const { cleanupStaleLlmRuns, getRunningLlmJob } = vi.hoisted(() => ({
  cleanupStaleLlmRuns: vi.fn(async () => ({ cleaned: 0 })),
  getRunningLlmJob: vi.fn(),
}));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ fetchFastAPI }));
vi.mock("@/actions/llm", () => ({ cleanupStaleLlmRuns, getRunningLlmJob }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@/lib/scroll", () => ({ getScrollBehavior: () => "auto" }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
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

  it("trata erro de rede no polling como NetworkError", async () => {
    getRunningLlmJob.mockResolvedValue(null);
    fetchFastAPI.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useLlmRunProgress("p1", null));
    await waitFor(() => expect(getRunningLlmJob).toHaveBeenCalled());

    act(() => result.current.start("job-3"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorInfo).toMatchObject({
      message: "offline",
      type: "NetworkError",
    });
  });

  it("retoma uma run em andamento ao montar", async () => {
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
  });
});
