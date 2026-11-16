import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type QueryError,
  type WriteCall,
} from "@/test-utils/supabase-mock";

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
  requireCoordinator: async (_projectId: string, deniedMessage: string) => {
    if (!hoisted.user) {
      return { ok: false, code: "unauthenticated", error: "Não autenticado" };
    }
    if (!(await hoisted.isCoord())) {
      return { ok: false, code: "forbidden", error: deniedMessage };
    }
    return { ok: true, user: hoisted.user };
  },
}));
vi.mock("@/actions/documents", () => ({
  excludeDocuments: (...args: unknown[]) =>
    hoisted.excludeDocuments(...(args as [])),
  revalidateProjectDocumentsCache: (...args: unknown[]) =>
    hoisted.revalidateProjectDocumentsCache(...(args as [])),
}));

let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError>;
let writeCalls: WriteCall[];

// Client criado por chamada: captura o estado corrente de cada teste.
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeFilterAwareSupabaseMock({ tableData, writeCalls, queryErrors }),
}));

// As linhas declaram as colunas que as queries filtram.
const doc = (extra: Record<string, unknown> = {}) => ({
  id: "d1", project_id: "p1", excluded_at: null, exclusion_pending_at: null, ...extra,
});
const project = (out_of_scope_enabled = true) => [
  { id: "p1", out_of_scope_enabled },
  { id: "p2", out_of_scope_enabled: !out_of_scope_enabled },
];
// Pedido de exclusão pendente de user-1 em d1, e o que o descaracteriza.
const comment = (id: string, extra: Record<string, unknown> = {}) => ({
  id, project_id: "p1", document_id: "d1", author_id: "user-1", kind: "exclusion_request",
  body: "fora do tema", resolved_at: null, rejected_at: null, ...extra,
});
// Comentários que nenhum filtro de pedido pendente de user-1 em d1 alcança.
const otherComments = [
  comment("x-resolvido", { resolved_at: "2026-01-01" }),
  comment("x-rejeitado", { rejected_at: "2026-01-01" }),
  comment("x-nota", { kind: "note" }),
  comment("x-outro-doc", { document_id: "d2" }),
  comment("x-outro-projeto", { project_id: "p2" }),
];
// O pedido pendente de user-1 (c1), o de outro autor no mesmo documento (c2)
// e os que nenhum filtro de pendente alcança.
const pendingComments = () => [comment("c1"), comment("c2", { author_id: "user-2" }), ...otherComments];

beforeEach(() => {
  tableData = {};
  queryErrors = {};
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

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/project-comments");
}, 30_000);

describe("requestDocumentExclusion — guardas", () => {
  it("sem justificativa → erro, sem escrita", async () => {
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "   ");
    expect(r.error).toContain("motivo");
    expect(writeCalls).toHaveLength(0);
  });

  it("documento inexistente → erro", async () => {
    // O d1 que existe é de outro projeto.
    tableData = { documents: [doc({ project_id: "p2" })], project_comments: [], projects: project() };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("não encontrado");
    expect(writeCalls).toHaveLength(0);
  });

  it("documento já excluído (soft delete) → erro", async () => {
    tableData = {
      documents: [doc({ excluded_at: "2026-01-01" })],
      project_comments: [],
      projects: project(),
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("removido");
    expect(writeCalls).toHaveLength(0);
  });

  it("duplicata: já existe pedido pendente do MESMO autor → erro", async () => {
    tableData = {
      documents: [doc({ exclusion_pending_at: "2026-01-01" })],
      project_comments: [comment("c1"), ...otherComments],
      projects: project(),
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("pendente");
    expect(writeCalls).toHaveLength(0);
  });

  it("doc em revisão sinalizado por OUTRO pesquisador → erro", async () => {
    tableData = {
      documents: [doc({ exclusion_pending_at: "2026-01-01" })],
      project_comments: [comment("c2", { author_id: "user-2" }), ...otherComments],
      projects: project(),
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("outro pesquisador");
    expect(writeCalls).toHaveLength(0);
  });

  it("recurso desligado pelo coordenador (out_of_scope_enabled=false) → erro, sem escrita", async () => {
    tableData = { documents: [doc()], project_comments: [], projects: project(false) };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "fora do tema");
    expect(r.error).toContain("desligada");
    expect(writeCalls).toHaveLength(0);
  });

  it("sucesso → insert de exclusion_request com a justificativa", async () => {
    tableData = {
      // d2, do mesmo projeto e excluído, não é o documento pedido.
      documents: [doc({ id: "d2", excluded_at: "2026-01-01" }), doc()],
      project_comments: [...otherComments],
      projects: project(),
    };
    const { requestDocumentExclusion } = await loadActions();
    const r = await requestDocumentExclusion("p1", "d1", "  fora do tema  ");
    expect(r).toEqual({ success: true });
    const inserts = callsOf(writeCalls, "insert", "project_comments");
    expect(inserts).toHaveLength(1);
    expect(writeCalls).toHaveLength(1);
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
    tableData = { project_comments: pendingComments() };
    const { cancelExclusionRequest } = await loadActions();
    const r = await cancelExclusionRequest("p1", "d1");
    expect(r).toEqual({ success: true });
    expect(callsOf(writeCalls, "delete", "project_comments").map((c) => c.filters)).toEqual([[
      ["eq", "project_id", "p1"],
      ["eq", "document_id", "d1"],
      ["eq", "author_id", "user-1"],
      ["eq", "kind", "exclusion_request"],
      ["is", "resolved_at", null],
      ["is", "rejected_at", null],
    ]]);
    expect(hoisted.revalidateProjectDocumentsCache).toHaveBeenCalledWith("p1");
  });

  it("sem pedido pendente do autor (RLS/no-op) → erro", async () => {
    // Só o pedido de outro autor e os que não estão pendentes.
    tableData = { project_comments: [comment("c2", { author_id: "user-2" }), ...otherComments] };
    const { cancelExclusionRequest } = await loadActions();
    const r = await cancelExclusionRequest("p1", "d1");
    expect(r.error).toContain("Nenhuma sugestão pendente");
  });

  // O texto do Postgres ia cru, em inglês, ao toast pt-BR: vai ao log do
  // servidor, e a action devolve a copy do fluxo (#502).
  it("erro do banco → copy pt-BR, texto cru no log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pgError = { code: "57014", message: "canceling statement due to statement timeout" };
    tableData = { project_comments: [comment("c1")] };
    queryErrors = { "project_comments:delete": pgError };
    const { cancelExclusionRequest } = await loadActions();
    const r = await cancelExclusionRequest("p1", "d1");
    expect(r).toEqual({
      error: copyWithRef("Não foi possível cancelar o pedido de exclusão. Tente novamente."),
    });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[project-comments] cancelar exclusão falhou", pgError),
    );
    consoleError.mockRestore();
  });
});

describe("approveExclusionRequest", () => {
  it("não-coordenador → barrado, sem efeito", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c1", "p1");
    expect(r.error).toContain("coordenador");
    expect(hoisted.excludeDocuments).not.toHaveBeenCalled();
  });

  it("sucesso → excludeDocuments (soft delete) + resolve os pedidos do doc", async () => {
    tableData = { project_comments: pendingComments() };
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c1", "p1");
    expect(r).toEqual({ success: true });
    expect(hoisted.excludeDocuments).toHaveBeenCalledWith(
      "p1",
      ["d1"],
      expect.stringContaining("fora do tema"),
    );
    const updates = callsOf(writeCalls, "update", "project_comments");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ resolved_by: "user-1" });
    // Todos os pedidos pendentes do documento, de qualquer autor.
    expect(updates[0].filters).toEqual([
      ["eq", "project_id", "p1"],
      ["eq", "document_id", "d1"],
      ["eq", "kind", "exclusion_request"],
      ["is", "resolved_at", null],
      ["is", "rejected_at", null],
    ]);
    expect(
      (updates[0].payload as { resolved_at: string }).resolved_at,
    ).toBeTruthy();
  });

  it("comentário que não é exclusion_request → erro", async () => {
    tableData = { project_comments: [comment("c1", { kind: "note" })] };
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c1", "p1");
    expect(r.error).toContain("não é uma sugestão");
    expect(hoisted.excludeDocuments).not.toHaveBeenCalled();
  });

  it("comentário de outro projeto → não encontrado, sem efeito", async () => {
    tableData = { project_comments: [comment("c9", { project_id: "p2" })] };
    const { approveExclusionRequest } = await loadActions();
    const r = await approveExclusionRequest("c9", "p1");
    expect(r.error).toContain("não encontrada");
    expect(hoisted.excludeDocuments).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
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
    // c1 existe, mas não é pedido de exclusão; c9 é de outro projeto.
    tableData = { project_comments: [comment("c1", { kind: "note" }), comment("c9", { project_id: "p2" })] };
    const { rejectExclusionRequest } = await loadActions();
    for (const id of ["c1", "c9"]) {
      const r = await rejectExclusionRequest(id, "p1", "está no escopo");
      expect(r.error).toContain("não encontrada");
    }
    expect(writeCalls).toEqual([]);
  });

  it("sucesso → rejeita em cascata os pedidos pendentes do doc", async () => {
    tableData = { project_comments: pendingComments() };
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", "está no escopo");
    expect(r).toEqual({ success: true });
    const updates = callsOf(writeCalls, "update", "project_comments");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      rejected_reason: "está no escopo",
      resolved_by: "user-1",
    });
    // Todos os pedidos pendentes do documento, de qualquer autor.
    expect(updates[0].filters).toEqual([
      ["eq", "project_id", "p1"],
      ["eq", "kind", "exclusion_request"],
      ["is", "resolved_at", null],
      ["is", "rejected_at", null],
      ["eq", "document_id", "d1"],
    ]);
    expect(hoisted.revalidateProjectDocumentsCache).toHaveBeenCalledWith("p1");
  });

  // Pedido órfão (documento apagado, document_id SET NULL): rejeita só ele, e
  // não os outros órfãos, que `document_id = NULL` nunca alcançaria mesmo.
  it("pedido sem documento → rejeita só o alvo", async () => {
    tableData = { project_comments: [comment("c1", { document_id: null }), comment("c2", { document_id: null })] };
    const { rejectExclusionRequest } = await loadActions();
    expect(await rejectExclusionRequest("c1", "p1", "está no escopo")).toEqual({ success: true });
    expect(callsOf(writeCalls, "update").map((c) => c.filters?.at(-1))).toEqual([["eq", "id", "c1"]]);
  });

  // O UPDATE que não alcança linha (pedido já decidido, ou RLS) não é sucesso.
  it("pedido que já foi decidido → erro, e não sucesso falso", async () => {
    tableData = { project_comments: [comment("c1", { resolved_at: "2026-01-01" })] };
    const { rejectExclusionRequest } = await loadActions();
    const r = await rejectExclusionRequest("c1", "p1", "está no escopo");
    expect(r).not.toHaveProperty("success");
    expect(r.error).toBeTruthy();
    expect(hoisted.revalidateProjectDocumentsCache).not.toHaveBeenCalled();
  });
});
