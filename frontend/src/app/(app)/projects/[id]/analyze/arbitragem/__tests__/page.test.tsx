import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAccessAuthModuleMock } from "@/test-utils/auth-mock";
import {
  makeFilterAwareSupabaseMock,
  type ReadCall,
} from "@/test-utils/supabase-mock";

const createSupabaseServer = vi.hoisted(() => vi.fn());
const authMocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  getProjectAccessContext: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServer }));
vi.mock("@/lib/auth", () => ({
  ...projectAccessAuthModuleMock(
    authMocks.getAuthUser,
    authMocks.getProjectAccessContext,
  ),
  resolveProjectQueueIdentity: (access: { memberUserId: string }) => ({
    queueUserId: access.memberUserId,
  }),
}));
vi.mock("@/lib/page-auth", () => ({
  requirePageAuthUser: authMocks.getAuthUser,
}));
vi.mock("@/components/arbitration/ArbitrationPage", () => ({
  ArbitrationPage: () => null,
}));

let tableData: Record<string, unknown[]>;
let readCalls: ReadCall[];
let queryErrors: Record<string, { message: string }>;

const docId = (i: number) => `doc-${String(i).padStart(3, "0")}`;

// Um documento na fila: assignment aberto, o documento e um campo contestado
// com as duas respostas dele.
function seedQueue(documents: number) {
  const indexes = Array.from({ length: documents }, (_, i) => i);
  tableData = {
    projects: [
      {
        id: "project-1",
        name: "Projeto",
        pydantic_fields: [],
        arbitration_blind: true,
      },
    ],
    project_members: [],
    assignments: indexes.map((i) => ({
      id: `assignment-${docId(i)}`,
      project_id: "project-1",
      user_id: "arbitrator",
      type: "arbitragem",
      status: "pendente",
      document_id: docId(i),
      "documents.excluded_at": null,
      "documents.exclusion_pending_at": null,
    })),
    documents: indexes.map((i) => ({
      id: docId(i),
      title: docId(i),
      external_id: null,
      text: "Texto",
      excluded_at: null,
      exclusion_pending_at: null,
    })),
    field_reviews: indexes.map((i) => ({
      id: `review-${docId(i)}`,
      project_id: "project-1",
      document_id: docId(i),
      field_name: "outcome",
      arbitrator_id: "arbitrator",
      self_verdict: "contesta_llm",
      superseded_at: null,
      final_verdict: null,
      blind_verdict: "humano",
      human_response_id: `human-${docId(i)}`,
      llm_response_id: `llm-${docId(i)}`,
    })),
    responses: indexes.flatMap((i) => [
      {
        id: `human-${docId(i)}`,
        respondent_type: "humano",
        respondent_id: "ana",
        respondent_name: "Ana",
      },
      {
        id: `llm-${docId(i)}`,
        respondent_type: "llm",
        respondent_id: null,
        respondent_name: "modelo",
      },
    ]),
  };
}

type ArbitrationProps = {
  docs: Array<{
    docId: string;
    fields: Array<{
      fieldReviewId: string;
      reveal: { humanName: string | null; llmName: string | null } | null;
    }>;
  }>;
};

async function renderRoute() {
  const route = (
    await import("@/app/(app)/projects/[id]/analyze/arbitragem/page")
  ).default;
  const result = await route({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({}),
  });
  return (result as ReactElement<ArbitrationProps>).props;
}

beforeEach(() => {
  vi.clearAllMocks();
  readCalls = [];
  queryErrors = {};
  createSupabaseServer.mockImplementation(async () =>
    makeFilterAwareSupabaseMock({
      tableData,
      writeCalls: [],
      readCalls,
      queryErrors,
    }),
  );
  authMocks.getAuthUser.mockResolvedValue({ id: "arbitrator", isMaster: false });
  authMocks.getProjectAccessContext.mockResolvedValue({
    status: "resolved",
    accountUserId: "arbitrator",
    memberUserId: "arbitrator",
    project: { id: "project-1", name: "Projeto", created_by: "coordinator" },
    membershipRole: "pesquisador",
    isMaster: false,
    isCoordinator: false,
  });
});

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/app/(app)/projects/[id]/analyze/arbitragem/page");
}, 30_000);

describe("ArbitrationRoute — leitura da fila", () => {
  it("monta o documento com o campo contestado e os nomes das duas respostas", async () => {
    seedQueue(1);

    const { docs } = await renderRoute();

    expect(docs).toEqual([
      expect.objectContaining({
        docId: "doc-000",
        fields: [
          expect.objectContaining({
            fieldReviewId: "review-doc-000",
            reveal: expect.objectContaining({
              humanName: "Ana",
              llmName: "modelo",
            }),
          }),
        ],
      }),
    ]);
  });

  it("deixa de fora assignment concluído e documento excluído", async () => {
    seedQueue(3);
    Object.assign(tableData.assignments[1] as object, { status: "concluido" });
    Object.assign(tableData.assignments[2] as object, {
      "documents.excluded_at": "2026-11-01T00:00:00Z",
    });

    const { docs } = await renderRoute();

    expect(docs.map((doc) => doc.docId)).toEqual(["doc-000"]);
  });

  // A lista inteira num `.in()` só vai na URL do PostgREST.
  it("fila grande vem inteira, com nenhum `.in()` acima de 100 ids", async () => {
    seedQueue(250);

    const { docs } = await renderRoute();

    expect(docs).toHaveLength(250);
    expect(docs.every((doc) => doc.fields[0].reveal?.humanName === "Ana")).toBe(
      true,
    );
    const inSizes = readCalls.flatMap((call) =>
      call.filters
        .filter(([kind]) => kind === "in")
        .map(([, , ids]) => (ids as unknown[]).length),
    );
    expect(Math.max(...inSizes)).toBe(100);
  });

  it("o mesmo documento em dois assignments abertos não repete os campos", async () => {
    seedQueue(1);
    tableData.assignments.push({
      ...(tableData.assignments[0] as object),
      id: "assignment-outro-round",
    });

    const { docs } = await renderRoute();

    expect(docs).toHaveLength(1);
    expect(docs[0].fields).toHaveLength(1);
  });

  it.each(["assignments", "documents", "field_reviews", "responses"])(
    "leitura de %s que falha derruba a página em vez de abrir a fila vazia",
    async (table) => {
      seedQueue(1);
      queryErrors[`${table}:select`] = { message: "timeout" };

      await expect(renderRoute()).rejects.toThrow(
        /Não foi possível carregar a fila de (arbitragem|revisão): timeout/,
      );
    },
  );
});
