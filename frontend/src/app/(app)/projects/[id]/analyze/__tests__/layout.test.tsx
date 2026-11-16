import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
        "documents.excluded_at": null,
        "documents.exclusion_pending_at": null,
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

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/app/(app)/projects/[id]/analyze/layout");
}, 30_000);

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

// A aba aparecia para uma fila que abria vazia: o probe não descontava
// documento excluído, e a fila desconta.
describe("AnalyzeLayout — pendência só de documento fora da fila", () => {
  it.each(["documents.excluded_at", "documents.exclusion_pending_at"])(
    "esconde a aba quando a única pendência é de documento com %s",
    async (column) => {
      Object.assign(tableData.field_reviews[0] as object, {
        [column]: "2026-11-01T00:00:00Z",
      });
      const layout = await loadLayout();

      const result = await layout({
        children: <div>Conteúdo</div>,
        params: Promise.resolve({ id: "project-1" }),
      });

      expect(getAnalyzeNavProps(result).showAutoReview).toBe(false);
    },
  );
});

// O mesmo defeito no probe da arbitragem: ele só conferia que existia um
// assignment, e a fila exige assignment aberto, documento ativo e campo
// contestado do ciclo corrente sem veredito final.
describe("AnalyzeLayout — arbitragem fora da fila", () => {
  async function showArbitragem(
    assignment: Record<string, unknown> = {},
    fieldReview: Record<string, unknown> = {},
  ) {
    tableData.assignments = [
      {
        id: "assignment-1",
        project_id: "project-1",
        user_id: "canonical-member",
        type: "arbitragem",
        status: "pendente",
        document_id: "doc-1",
        "documents.excluded_at": null,
        "documents.exclusion_pending_at": null,
        ...assignment,
      },
    ];
    tableData.field_reviews = [
      {
        id: "review-arbitragem",
        project_id: "project-1",
        document_id: "doc-1",
        arbitrator_id: "canonical-member",
        self_verdict: "contesta_llm",
        superseded_at: null,
        final_verdict: null,
        "documents.excluded_at": null,
        "documents.exclusion_pending_at": null,
        ...fieldReview,
      },
    ];
    const layout = await loadLayout();
    const result = await layout({
      children: <div>Conteúdo</div>,
      params: Promise.resolve({ id: "project-1" }),
    });
    return getAnalyzeNavProps(result).showArbitragem;
  }

  it("mostra a aba para arbitragem aberta de documento ativo", async () => {
    expect(await showArbitragem()).toBe(true);
  });

  const excluded = { "documents.excluded_at": "2026-11-01T00:00:00Z" };
  const exclusionPending = {
    "documents.exclusion_pending_at": "2026-11-01T00:00:00Z",
  };
  it.each([
    ["o assignment já foi concluído", { status: "concluido" }, {}],
    ["o documento foi excluído", excluded, excluded],
    ["o documento está com exclusão pendente", exclusionPending, exclusionPending],
    ["o campo é de ciclo superado", {}, { superseded_at: "2026-11-01T00:00:00Z" }],
    ["o campo já tem veredito final", {}, { final_verdict: "humano" }],
    ["o campo está com outro árbitro", {}, { arbitrator_id: "outro" }],
    ["o campo pendente é de outro documento", {}, { document_id: "doc-2" }],
  ])("esconde a aba quando %s", async (_, assignment, fieldReview) => {
    expect(await showArbitragem(assignment, fieldReview)).toBe(false);
  });
});
