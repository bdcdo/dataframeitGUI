import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeSupabaseMock,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

// Fluxo "fora do escopo": pesquisador sinaliza (requestDocumentExclusion),
// pode desfazer (cancelExclusionRequest) e o coordenador decide
// (approve/rejectExclusionRequest). O estado documents.exclusion_pending_at é
// mantido por trigger no banco — aqui testamos só as guardas e escritas das
// actions.

const hoisted = vi.hoisted(() => ({
  user: { id: "user-1", email: "u@test.com" } as { id: string } | null,
  isCoord: vi.fn(async () => true),
  excludeDocuments: vi.fn(async () => ({ count: 1 })),
  revalidateProjectDocumentsCache: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => hoisted.user),
  isProjectCoordinator: () => hoisted.isCoord(),
  requireCoordinator: async (_projectId: string, deniedMessage: string) => {
    if (!hoisted.user) return { ok: false, error: "Não autenticado" };
    if (!(await hoisted.isCoord())) return { ok: false, error: deniedMessage };
    return { ok: true, user: hoisted.user };
  },
}));
vi.mock("@/actions/documents", () => ({
  excludeDocuments: (...args: unknown[]) =>
    hoisted.excludeDocuments(...(args as [])),
  revalidateProjectDocumentsCache: (...args: unknown[]) =>
    hoisted.revalidateProjectDocumentsCache(...(args as [])),
}));

let tableResults: TableResults;
let writeCalls: WriteCall[];

// Client criado por chamada: captura o estado corrente de cada teste (o
// makeSupabaseMock guarda as referências passadas na criação).
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults, writeCalls }),
}));

const activeDoc = { excluded_at: null, exclusion_pending_at: null };
const enabledProject = { data: { out_of_scope_enabled: true } };

beforeEach(() => {
  tableResults = {};
  writeCalls = [];
  hoisted.user = { id: "user-1" };
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.excludeDocuments.mockClear();
  hoisted.excludeDocuments.mockResolvedValue({ count: 1 });
  hoisted.revalidateProjectDocumentsCache.mockClear();
});

async function loadActions() {
  return import("@/actions/project-comments");
}

describe("requestDocumentExclusion — guardas", () => {
  it("sem justificativa → erro, sem escrita", async () => {
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "   ");
    expect(r.error).toContain("motivo");
    expect(writeCalls).toHaveLength(0);
  });

  it("documento inexistente → erro", async () => {
    tableResults = {
      documents: { data: null },
      project_comments: { data: null },
      projects: enabledProject,
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("não encontrado");
    expect(writeCalls).toHaveLength(0);
  });

  it("documento já excluído (soft delete) → erro", async () => {
    tableResults = {
      documents: { data: { ...activeDoc, excluded_at: "2026-01-01" } },
      project_comments: { data: null },
      projects: enabledProject,
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("removido");
    expect(writeCalls).toHaveLength(0);
  });

  it("duplicata: já existe pedido pendente do MESMO autor → erro", async () => {
    tableResults = {
      documents: {
        data: { ...activeDoc, exclusion_pending_at: "2026-01-01" },
      },
      project_comments: { data: { id: "c1" } },
      projects: enabledProject,
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("pendente");
    expect(writeCalls).toHaveLength(0);
  });

  it("doc em revisão sinalizado por OUTRO pesquisador → erro", async () => {
    tableResults = {
      documents: {
        data: { ...activeDoc, exclusion_pending_at: "2026-01-01" },
      },
      project_comments: { data: null },
      projects: enabledProject,
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("outro pesquisador");
    expect(writeCalls).toHaveLength(0);
  });

  it("recurso desligado pelo coordenador (out_of_scope_enabled=false) → erro, sem escrita", async () => {
    tableResults = {
      documents: { data: activeDoc },
      project_comments: { data: null },
      projects: { data: { out_of_scope_enabled: false } },
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("desligada");
    expect(writeCalls).toHaveLength(0);
  });

  it("sucesso → insert de exclusion_request com a justificativa", async () => {
    tableResults = {
      documents: { data: activeDoc },
      project_comments: [{ data: null }, { data: null, error: null }],
      projects: enabledProject,
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "  fora do tema  ");
    expect(r).toEqual({ success: true });
    const inserts = writeCalls.filter((c) => c.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({
      project_id: "p1",
      document_id: "d1",
      author_id: "user-1",
      kind: "exclusion_request",
      body: "fora do tema",
    });
    expect(hoisted.revalidateProjectDocumentsCache).toHaveBeenCalledWith("p1");
  });
});

describe("cancelExclusionRequest", () => {
  it("apaga o pedido pendente do próprio autor", async () => {
    tableResults = { project_comments: { data: [{ id: "c1" }] } };
    const { cancelExclusionRequest } = await loadActions();
    const r = await cancelExclusionRequest("p1", "d1");
    expect(r).toEqual({ success: true });
    expect(writeCalls.filter((c) => c.op === "delete")).toHaveLength(1);
    expect(hoisted.revalidateProjectDocumentsCache).toHaveBeenCalledWith("p1");
  });

  it("sem pedido pendente do autor (RLS/no-op) → erro", async () => {
    tableResults = { project_comments: { data: [] } };
    const { cancelExclusionRequest } = await loadActions();
    const r = await cancelExclusionRequest("p1", "d1");
    expect(r.error).toContain("Nenhuma sugestão pendente");
  });
});

describe("approveExclusionRequest", () => {
  const comment = {
    id: "c1",
    document_id: "d1",
    body: "fora do tema",
    kind: "exclusion_request",
  };

  it("não-coordenador → barrado, sem efeito", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c1", "p1");
    expect(r.error).toContain("coordenador");
    expect(hoisted.excludeDocuments).not.toHaveBeenCalled();
  });

  it("sucesso → excludeDocuments (soft delete) + resolve os pedidos do doc", async () => {
    tableResults = {
      project_comments: [{ data: comment }, { data: null, error: null }],
    };
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c1", "p1");
    expect(r).toEqual({ success: true });
    expect(hoisted.excludeDocuments).toHaveBeenCalledWith(
      "p1",
      ["d1"],
      expect.stringContaining("fora do tema"),
    );
    const updates = writeCalls.filter(
      (c) => c.op === "update" && c.table === "project_comments",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ resolved_by: "user-1" });
    expect(
      (updates[0].payload as { resolved_at: string }).resolved_at,
    ).toBeTruthy();
  });

  it("comentário que não é exclusion_request → erro", async () => {
    tableResults = {
      project_comments: { data: { ...comment, kind: "note" } },
    };
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c1", "p1");
    expect(r.error).toContain("não é uma sugestão");
    expect(hoisted.excludeDocuments).not.toHaveBeenCalled();
  });
});

describe("rejectExclusionRequest", () => {
  it("sem motivo → erro", async () => {
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", " ");
    expect(r.error).toContain("motivo");
  });

  it("não-coordenador → barrado", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", "está no escopo");
    expect(r.error).toContain("coordenador");
    expect(writeCalls).toHaveLength(0);
  });

  it("não-coordenador COM motivo vazio → erro de coordenador (gate roda antes da validação de motivo)", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", " ");
    expect(r.error).toContain("coordenador");
    expect(writeCalls).toHaveLength(0);
  });

  it("alvo inexistente → erro", async () => {
    tableResults = { project_comments: { data: null } };
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", "está no escopo");
    expect(r.error).toContain("não encontrada");
  });

  it("sucesso → rejeita em cascata os pedidos pendentes do doc", async () => {
    tableResults = {
      project_comments: [
        { data: { id: "c1", document_id: "d1" } },
        { data: [{ id: "c1" }, { id: "c2" }] },
      ],
    };
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", "está no escopo");
    expect(r).toEqual({ success: true });
    const updates = writeCalls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      rejected_reason: "está no escopo",
      resolved_by: "user-1",
    });
    expect(hoisted.revalidateProjectDocumentsCache).toHaveBeenCalledWith("p1");
  });
});
