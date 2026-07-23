import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectAccessAuthModuleMock } from "@/test-utils/auth-mock";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

const createSupabaseServer = vi.hoisted(() => vi.fn());
const authMocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  getProjectAccessContext: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer,
}));

vi.mock("@/lib/auth", () =>
  projectAccessAuthModuleMock(
    authMocks.getAuthUser,
    authMocks.getProjectAccessContext,
  ),
);
vi.mock("@/lib/page-auth", () => ({
  requirePageAuthUser: authMocks.getAuthUser,
}));

vi.mock("@/components/auto-review/AutoReviewPage", () => ({
  AutoReviewPage: () => null,
}));

let tableData: Record<string, unknown[]>;

function seedQueue(ownerId: string) {
  tableData = {
    projects: [
      {
        id: "project-1",
        pydantic_fields: [
          { name: "outcome", description: "Resultado", type: "str" },
        ],
      },
    ],
    project_members: [],
    documents: [
      {
        id: "doc-1",
        title: "Documento",
        external_id: "EXT-1",
        text: "Texto",
        excluded_at: null,
        exclusion_pending_at: null,
      },
    ],
    field_reviews: [
      {
        id: "review-1",
        project_id: "project-1",
        document_id: "doc-1",
        field_name: "outcome",
        self_reviewer_id: ownerId,
        superseded_at: null,
        self_verdict: null,
        self_justification: null,
        human_answer_snapshot: "A",
        llm_answer_snapshot: "B",
        llm_justification_snapshot: "Justificativa",
      },
    ],
  };
}

type AutoReviewProps = {
  ownQueueUserId: string;
  docs: Array<{ docId: string }>;
  queueUserId: string;
};

function getAutoReviewProps(result: unknown): AutoReviewProps {
  const root = result as ReactElement<{
    children?: ReactElement<AutoReviewProps>;
  }>;
  return root.props.children?.props ?? (root.props as AutoReviewProps);
}

async function loadRoute() {
  return (await import("@/app/(app)/projects/[id]/analyze/auto-revisao/page"))
    .default;
}

async function renderRoute(viewAs?: string) {
  const route = await loadRoute();
  const result = await route({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve(viewAs ? { viewAs } : {}),
  });
  return getAutoReviewProps(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  tableData = {};
  createSupabaseServer.mockImplementation(async () =>
    makeFilterAwareSupabaseMock({ tableData, writeCalls: [] }),
  );
  authMocks.getAuthUser.mockResolvedValue({
    id: "linked-account",
    email: "alias@example.com",
    firstName: "Conta",
    lastName: "Alias",
    clerkId: "clerk-alias",
    isMaster: false,
  });
  authMocks.getProjectAccessContext.mockResolvedValue({
    status: "resolved",
    accountUserId: "linked-account",
    memberUserId: "canonical-member",
    project: { id: "project-1", name: "Projeto", created_by: "coordinator" },
    membershipRole: "pesquisador",
    isMaster: false,
    isCoordinator: false,
  });
});

describe("AutoReviewRoute — identidade efetiva", () => {
  it("filtra ciclos ativos pelo membro canônico da conta-alias", async () => {
    seedQueue("canonical-member");
    const props = await renderRoute();

    expect(authMocks.getProjectAccessContext).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ id: "linked-account", isMaster: false }),
    );
    expect(props).toMatchObject({
      ownQueueUserId: "canonical-member",
      queueUserId: "canonical-member",
      docs: [{ docId: "doc-1" }],
    });
  });

  it("ignora viewAs para não-coordenador e mantém a fila canônica editável", async () => {
    seedQueue("canonical-member");
    const props = await renderRoute("selected-member");
    expect(props).toMatchObject({
      ownQueueUserId: "canonical-member",
      queueUserId: "canonical-member",
      docs: [{ docId: "doc-1" }],
    });
    expect(props.queueUserId === props.ownQueueUserId).toBe(true);
  });

  it("mantém o viewAs de coordenador com precedência e em modo somente leitura", async () => {
    seedQueue("selected-member");
    authMocks.getProjectAccessContext.mockResolvedValue({
      status: "resolved",
      accountUserId: "linked-account",
      memberUserId: "canonical-member",
      project: { id: "project-1", name: "Projeto", created_by: "coordinator" },
      membershipRole: "coordenador",
      isMaster: false,
      isCoordinator: true,
    });
    const props = await renderRoute("selected-member");
    expect(props).toMatchObject({
      ownQueueUserId: "canonical-member",
      queueUserId: "selected-member",
      docs: [{ docId: "doc-1" }],
    });
    expect(props.queueUserId === props.ownQueueUserId).toBe(false);
  });
});
