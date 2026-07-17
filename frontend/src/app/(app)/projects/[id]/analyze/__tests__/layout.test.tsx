import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectAccessAuthModuleMock } from "@/test-utils/auth-mock";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

const mocks = vi.hoisted(() => ({
  createSupabaseServer: vi.fn(),
  getAuthUser: vi.fn(),
  getProjectAccessContext: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: mocks.createSupabaseServer,
}));

vi.mock("@/lib/auth", () =>
  projectAccessAuthModuleMock(mocks.getAuthUser, mocks.getProjectAccessContext),
);
vi.mock("@/lib/page-auth", () => ({
  requirePageAuthUser: mocks.getAuthUser,
}));

vi.mock("@/components/analyze/AnalyzeNav", () => ({
  AnalyzeNav: () => null,
}));

let tableData: Record<string, unknown[]>;

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
  tableData = {
    projects: [{ id: "project-1", automation_mode: "compare_humans" }],
    assignments: [],
    field_reviews: [
      {
        id: "review-1",
        project_id: "project-1",
        self_reviewer_id: "canonical-member",
        superseded_at: null,
        self_verdict: null,
      },
    ],
  };
  mocks.createSupabaseServer.mockResolvedValue(
    makeFilterAwareSupabaseMock({ tableData, writeCalls: [] }),
  );
  mocks.getAuthUser.mockResolvedValue({
    id: "linked-account",
    isMaster: false,
  });
  mocks.getProjectAccessContext.mockResolvedValue({
    status: "resolved",
    accountUserId: "linked-account",
    memberUserId: "canonical-member",
    project: { id: "project-1", name: "Projeto", created_by: "coordinator" },
    membershipRole: "pesquisador",
    isMaster: false,
    isCoordinator: false,
  });
});

describe("AnalyzeLayout — identidade efetiva da fila", () => {
  it("mantém a aba visível para ciclo ativo do membro canônico da conta-alias", async () => {
    const layout = await loadLayout();

    const result = await layout({
      children: <div>Conteúdo</div>,
      params: Promise.resolve({ id: "project-1" }),
    });

    expect(mocks.getProjectAccessContext).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ id: "linked-account", isMaster: false }),
    );
    expect(getAnalyzeNavProps(result)).toMatchObject({
      showAutoReview: true,
      showArbitragem: false,
      showCompare: false,
    });
  });
});
