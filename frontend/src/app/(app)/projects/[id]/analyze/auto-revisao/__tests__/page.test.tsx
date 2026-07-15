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

vi.mock("@/components/auto-review/AutoReviewPage", () => ({
  AutoReviewPage: () => null,
}));

type Row = Record<string, unknown>;
type Filter = {
  method: "eq" | "neq" | "is" | "in";
  column: string;
  value: unknown;
};
type QueryCall = { table: string; filters: Filter[] };

let tableData: Record<string, Row[]>;
let queryCalls: QueryCall[];

function makeSupabaseMock() {
  return {
    from(table: string) {
      const call: QueryCall = { table, filters: [] };
      queryCalls.push(call);
      let returnsSingleRow = false;
      const builder: Record<string, unknown> = {};

      builder.select = () => builder;
      for (const method of ["eq", "neq", "is", "in"] as const) {
        builder[method] = (column: string, value: unknown) => {
          call.filters.push({ method, column, value });
          return builder;
        };
      }
      builder.single = () => {
        returnsSingleRow = true;
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => {
        const rows = (tableData[table] ?? []).filter((row) =>
          call.filters.every(({ method, column, value }) => {
            if (method === "neq") return row[column] !== value;
            if (method === "in") {
              return (value as unknown[]).includes(row[column]);
            }
            return row[column] === value;
          }),
        );
        return resolve({
          data: returnsSingleRow ? (rows[0] ?? null) : rows,
          error: null,
        });
      };

      return builder;
    },
  };
}

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
    assignments: [
      {
        project_id: "project-1",
        document_id: "doc-1",
        user_id: ownerId,
        type: "auto_revisao",
        status: "pendente",
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
        document_id: "doc-1",
        field_name: "outcome",
        human_response_id: "human-1",
        llm_response_id: "llm-1",
        self_reviewer_id: ownerId,
        self_verdict: null,
        self_justification: null,
      },
    ],
    responses: [
      {
        id: "human-1",
        document_id: "doc-1",
        respondent_type: "human",
        answers: { outcome: "A" },
        justifications: null,
      },
      {
        id: "llm-1",
        document_id: "doc-1",
        respondent_type: "llm",
        answers: { outcome: "B" },
        justifications: { outcome: "Justificativa" },
      },
    ],
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

type AutoReviewProps = {
  currentUserId: string;
  docs: Array<{ docId: string }>;
  viewAsUserId: string;
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

beforeEach(() => {
  vi.clearAllMocks();
  queryCalls = [];
  tableData = {};
  mocks.createSupabaseServer.mockResolvedValue(makeSupabaseMock());
  mocks.getAuthUser.mockResolvedValue({
    id: "linked-account",
    email: "alias@example.com",
    firstName: "Conta",
    lastName: "Alias",
    clerkId: "clerk-alias",
    isMaster: false,
  });
});

describe("AutoReviewRoute — identidade efetiva", () => {
  it("filtra assignments e field_reviews pelo membro canônico da conta-alias", async () => {
    seedQueue("canonical-member");
    mocks.isProjectCoordinator.mockResolvedValue(false);
    mocks.resolveEffectiveUserId.mockResolvedValue({
      effectiveUserId: "canonical-member",
      isImpersonating: false,
    });
    const route = await loadRoute();

    const result = await route({
      params: Promise.resolve({ id: "project-1" }),
      searchParams: Promise.resolve({}),
    });

    expect(mocks.resolveEffectiveUserId).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ id: "linked-account", isMaster: false }),
      undefined,
    );
    expect(filterValues("assignments", "user_id")).toEqual([
      "canonical-member",
    ]);
    expect(filterValues("field_reviews", "self_reviewer_id")).toEqual([
      "canonical-member",
    ]);
    expect(getAutoReviewProps(result)).toMatchObject({
      currentUserId: "canonical-member",
      viewAsUserId: "canonical-member",
      docs: [{ docId: "doc-1" }],
    });
  });

  it("ignora viewAs para não-coordenador e mantém a fila canônica editável", async () => {
    seedQueue("canonical-member");
    mocks.isProjectCoordinator.mockResolvedValue(false);
    mocks.resolveEffectiveUserId.mockResolvedValue({
      effectiveUserId: "canonical-member",
      isImpersonating: false,
    });
    const route = await loadRoute();

    const result = await route({
      params: Promise.resolve({ id: "project-1" }),
      searchParams: Promise.resolve({ viewAs: "selected-member" }),
    });

    expect(filterValues("assignments", "user_id")).toEqual([
      "canonical-member",
    ]);
    expect(filterValues("field_reviews", "self_reviewer_id")).toEqual([
      "canonical-member",
    ]);
    const props = getAutoReviewProps(result);
    expect(props).toMatchObject({
      currentUserId: "canonical-member",
      viewAsUserId: "canonical-member",
      docs: [{ docId: "doc-1" }],
    });
    expect(props.viewAsUserId === props.currentUserId).toBe(true);
  });

  it("mantém o viewAs de coordenador com precedência e em modo somente leitura", async () => {
    seedQueue("selected-member");
    mocks.isProjectCoordinator.mockResolvedValue(true);
    mocks.resolveEffectiveUserId.mockResolvedValue({
      effectiveUserId: "canonical-member",
      isImpersonating: false,
    });
    const route = await loadRoute();

    const result = await route({
      params: Promise.resolve({ id: "project-1" }),
      searchParams: Promise.resolve({ viewAs: "selected-member" }),
    });

    expect(mocks.resolveEffectiveUserId).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ id: "linked-account", isMaster: false }),
      undefined,
    );
    expect(filterValues("assignments", "user_id")).toEqual([
      "selected-member",
    ]);
    expect(filterValues("field_reviews", "self_reviewer_id")).toEqual([
      "selected-member",
    ]);
    const props = getAutoReviewProps(result);
    expect(props).toMatchObject({
      currentUserId: "canonical-member",
      viewAsUserId: "selected-member",
      docs: [{ docId: "doc-1" }],
    });
    expect(props.viewAsUserId === props.currentUserId).toBe(false);
  });
});
