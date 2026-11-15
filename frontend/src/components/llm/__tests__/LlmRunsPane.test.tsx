// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { cleanup, render, screen } from "@testing-library/react";
import { LlmRunsPane } from "@/components/llm/LlmRunsPane";
import type { LlmRunRecord } from "@/actions/llm";

beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

const run = (id: string, roundId: string): LlmRunRecord => ({
  id,
  job_id: `job-${id}`,
  status: "completed",
  phase: null,
  llm_provider: null,
  llm_model: null,
  filter_mode: "all",
  document_count: 3,
  progress: 3,
  total: 3,
  pydantic_code: null,
  error_message: null,
  error_type: null,
  error_traceback: null,
  error_line: null,
  error_column: null,
  started_at: "2026-08-10T12:00:00Z",
  completed_at: "2026-08-10T12:01:00Z",
  round_id: roundId,
});

describe("LlmRunsPane — rodada da run (#675)", () => {
  it("exibe o rótulo da rodada de cada run", () => {
    render(
      <LlmRunsPane
        projectId="p1"
        runs={[run("a", "r1"), run("b", "r2")]}
        stats={{}}
        rounds={[
          { id: "r1", label: "Rodada inicial" },
          { id: "r2", label: "Segunda rodada" },
        ]}
      />,
    );

    const summaries = screen.getAllByText(/docs ·/);
    expect(summaries.map((el) => el.textContent)).toEqual([
      expect.stringMatching(/3 docs · Rodada inicial$/),
      expect.stringMatching(/3 docs · Segunda rodada$/),
    ]);
  });
});
