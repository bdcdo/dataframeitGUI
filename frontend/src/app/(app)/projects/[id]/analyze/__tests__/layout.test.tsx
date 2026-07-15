import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServer: vi.fn(),
  getAuthUser: vi.fn(),
  isProjectCoordinator: vi.fn(),
  resolveEffectiveUserId: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: mocks.createSupabaseServer,
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: mocks.getAuthUser,
  isProjectCoordinator: mocks.isProjectCoordinator,
  resolveEffectiveUserId: mocks.resolveEffectiveUserId,
}));

vi.mock("@/components/analyze/AnalyzeNav", () => ({
  AnalyzeNav: () => null,
}));

type Row = Record<string, unknown>;
type Filter = { column: string; value: unknown };
type QueryCall = { table: string; filters: Filter[] };

let tableData: Record<string, Row[]>;
let queryCalls: QueryCall[];

function makeSupabaseMock() {
  return {
    from(table: string) {
      const call: QueryCall = { table, filters: [] };
      queryCalls.push(call);
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: unknown) => {
        call.filters.push({ column, value });
        return builder;
      };
      builder.limit = () => builder;

      const firstMatchingRow = () =>
        (tableData[table] ?? []).find((row) =>
          call.filters.every(({ column, value }) => row[column] === value),
        ) ?? null;
      builder.maybeSingle = async () => ({
        data: firstMatchingRow(),
        error: null,
      });
      builder.single = async () => ({
        data: firstMatchingRow(),
        error: null,
      });
      return builder;
    },
  };
}

function filterValues(table: string, column: string): unknown[] {
  return queryCalls
    .filter((call) => call.table === table)
    .flatMap((call) =>
      call.filters
        .filter((filter) => filter.column === column)
        .map((filter) => filter.value),
    );
}

type AnalyzeNavProps = {
  showArbitragem: boolean;
  showAutoReview: boolean;
  showCompare: boolean;
};

function getAnalyzeNavProps(result: unknown): AnalyzeNavProps {
  const root = result as ReactElement<{
    children: [ReactElement<AnalyzeNavProps>, ReactElement];
  }>;
  return root.props.children[0].props;
}

async function loadLayout() {
  return (await import("@/app/(app)/projects/[id]/analyze/layout")).default;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryCalls = [];
  tableData = {
    projects: [
      { id: "project-1", automation_mode: "compare_humans" },
    ],
    assignments: [
      {
        id: "assignment-1",
        project_id: "project-1",
        user_id: "canonical-member",
        type: "auto_revisao",
      },
    ],
  };
  mocks.createSupabaseServer.mockResolvedValue(makeSupabaseMock());
  mocks.getAuthUser.mockResolvedValue({
    id: "linked-account",
    isMaster: false,
  });
  mocks.isProjectCoordinator.mockResolvedValue(false);
  mocks.resolveEffectiveUserId.mockResolvedValue({
    effectiveUserId: "canonical-member",
    isImpersonating: false,
  });
});

describe("AnalyzeLayout — identidade efetiva dos assignments", () => {
  it("mantém a aba visível para assignment do membro canônico da conta-alias", async () => {
    const layout = await loadLayout();

    const result = await layout({
      children: <div>Conteúdo</div>,
      params: Promise.resolve({ id: "project-1" }),
    });

    expect(mocks.resolveEffectiveUserId).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ id: "linked-account", isMaster: false }),
      undefined,
    );
    expect(filterValues("assignments", "user_id")).toEqual([
      "canonical-member",
      "canonical-member",
      "canonical-member",
    ]);
    expect(getAnalyzeNavProps(result)).toMatchObject({
      showAutoReview: true,
      showArbitragem: false,
      showCompare: false,
    });
  });
});
