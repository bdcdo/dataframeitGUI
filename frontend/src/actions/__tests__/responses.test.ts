import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath, revalidateTag } from "next/cache";
import { isCodingComplete } from "@/lib/coding-completeness";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

const drainAutoReviewReconciliationRequests = vi.hoisted(() => vi.fn(async () => ({
  processed: 1,
  stale: 0,
  deferred: 0,
  failed: 0,
  remaining: 0,
})));

// Mocks precisam ser declarados antes do import dinamico do modulo sob teste.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveProjectMemberActor: vi.fn(async () => ({
    ok: true,
    user: { id: "user-1", email: "u@test.com" },
    memberUserId: "user-1",
  })),
}));
vi.mock("@/lib/auto-review-reconciler", () => ({
  drainAutoReviewReconciliationRequests,
}));

interface State {
  responseInsertPayload: Record<string, unknown> | null;
  responseUpdatePayload: Record<string, unknown> | null;
  assignmentUpdatePayload: Record<string, unknown> | null;
  existingResponse: {
    id: string;
    is_partial: boolean;
    answers?: Record<string, unknown>;
    answer_field_hashes?: Record<string, string | null> | null;
  } | null;
  currentAssignmentStatus: string | null;
  pydanticFields: Array<{
    name: string;
    type: string;
    required?: boolean;
    options?: string[];
    target?: string;
    hash?: string;
  }>;
  schemaVersion: { major: number; minor: number; patch: number };
  documentExcludedAt: string | null;
  automationMode: string | null;
}

let state: State;

beforeEach(() => {
  state = {
    responseInsertPayload: null,
    responseUpdatePayload: null,
    assignmentUpdatePayload: null,
    existingResponse: null,
    currentAssignmentStatus: "pendente",
    pydanticFields: [
      { name: "q1", type: "single", required: true, options: ["a", "b"] },
    ],
    schemaVersion: { major: 1, minor: 0, patch: 0 },
    documentExcludedAt: null,
    automationMode: null,
  };
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(revalidateTag).mockClear();
  drainAutoReviewReconciliationRequests.mockClear();
});

// Builder generico awaitable: usado quando o resultado final eh `{ error: null }`
// e o encadeamento termina em await (sem `.single()`).
function thenableOk() {
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.then = (resolve: (v: { error: null }) => unknown) =>
    resolve({ error: null });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { first_name: "Test", last_name: "User" },
              }),
            }),
          }),
        };
      }
      if (table === "projects") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  pydantic_hash: "hash-1",
                  pydantic_fields: state.pydanticFields,
                  schema_version_major: state.schemaVersion.major,
                  schema_version_minor: state.schemaVersion.minor,
                  schema_version_patch: state.schemaVersion.patch,
                  round_strategy: "schema_version",
                  current_round_id: null,
                  automation_mode: state.automationMode,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "responses") {
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            c.single = async () => ({ data: state.existingResponse });
            c.maybeSingle = async () => ({ data: state.existingResponse });
            return c;
          },
          insert: async (payload: Record<string, unknown>) => {
            state.responseInsertPayload = payload;
            return { error: null };
          },
          update: (payload: Record<string, unknown>) => {
            state.responseUpdatePayload = payload;
            return thenableOk();
          },
        };
      }
      if (table === "documents") {
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            c.maybeSingle = async () => ({
              data: { excluded_at: state.documentExcludedAt },
            });
            return c;
          },
        };
      }
      if (table === "assignments") {
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            c.maybeSingle = async () => ({
              data: state.currentAssignmentStatus
                ? { status: state.currentAssignmentStatus }
                : null,
            });
            return c;
          },
          update: (payload: Record<string, unknown>) => {
            state.assignmentUpdatePayload = payload;
            return thenableOk();
          },
        };
      }
      return {};
    },
  }),
}));

async function loadSaveResponse() {
  return (await import("@/actions/responses")).saveResponse;
}

describe("saveResponse — auto-save vs submit explicito", () => {
  it("auto-save com todos os campos preenchidos NAO promove assignment para concluido", async () => {
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse(
      "proj-1",
      "doc-1",
      { q1: "a" },
      { isAutoSave: true },
    );
    expect(r.success).toBe(true);
    // Auto-save em assignment pendente promove apenas para em_andamento — nunca concluido.
    expect(state.assignmentUpdatePayload?.status).toBe("em_andamento");
    expect(state.assignmentUpdatePayload?.completed_at).toBeNull();
  });

  it("submit explicito com todos os campos preenchidos promove assignment para concluido", async () => {
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse(
      "proj-1",
      "doc-1",
      { q1: "a" },
      // isAutoSave default = false
    );
    expect(r.success).toBe(true);
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
    expect(typeof state.assignmentUpdatePayload?.completed_at).toBe("string");
  });

  it("auto-save em response nova grava is_partial=true (INSERT)", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { isAutoSave: true });
    expect(state.responseInsertPayload?.is_partial).toBe(true);
  });

  it("submit explicito grava response com is_partial=false", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseInsertPayload?.is_partial).toBe(false);
  });

  it("auto-save em response existente parcial mantem is_partial=true (UPDATE)", async () => {
    // Pesquisador ja salvou parcial antes; novo auto-save deve continuar parcial.
    state.existingResponse = { id: "resp-1", is_partial: true };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { isAutoSave: true });
    expect(state.responseUpdatePayload?.is_partial).toBe(true);
  });

  it("auto-save em response ja submetida NAO rebaixa is_partial (UPDATE)", async () => {
    // Cenario critico: response existe com is_partial=false (foi submetida) e
    // assignment esta concluido. Pesquisador reabre e edita; auto-save NAO
    // deve flipar is_partial para true, senao classifyDocStatus passa a tratar
    // o doc como pendente mesmo com o assignment.status preservado pelo guard
    // como concluido — estado inconsistente.
    state.existingResponse = { id: "resp-1", is_partial: false };
    state.currentAssignmentStatus = "concluido";
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { isAutoSave: true });
    expect(state.responseUpdatePayload?.is_partial).toBe(false);
    // Assignment.status nao deve regredir (guard pre-existente).
    expect(state.assignmentUpdatePayload).toBeNull();
  });

  it("auto-save em response já submetida invalida imediatamente a auto-revisão", async () => {
    state.existingResponse = { id: "resp-1", is_partial: false };
    state.currentAssignmentStatus = "concluido";
    state.automationMode = "compare_humans";
    const saveResponse = await loadSaveResponse();

    const result = await saveResponse(
      "proj-1",
      "doc-1",
      { q1: "b" },
      { isAutoSave: true },
    );

    expect(result.success).toBe(true);
    expect(drainAutoReviewReconciliationRequests).toHaveBeenCalledWith({
      projectId: "proj-1",
    });
  });

  it("submit apos auto-save sobrescreve is_partial: true -> false (UPDATE)", async () => {
    // Cenario: o pesquisador deu auto-save antes (response existe com is_partial=true)
    // e agora clica Enviar — o submit deve fazer UPDATE com is_partial=false.
    state.existingResponse = { id: "resp-1", is_partial: true };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseUpdatePayload?.is_partial).toBe(false);
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
  });

  it("preserva resposta stale e seu hash sem usá-la para concluir a codificação", async () => {
    state.pydanticFields = [
      {
        name: "q_stale",
        type: "single",
        required: true,
        options: ["X", "Y"],
        hash: "h-stale-new",
      },
      { name: "q_txt", type: "text", required: true, hash: "h-text" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q_stale: "A", q_txt: "antigo" },
      answer_field_hashes: { q_stale: "h-stale-old", q_txt: "h-text" },
    };

    const saveResponse = await loadSaveResponse();
    const result = await saveResponse("proj-1", "doc-1", { q_txt: "novo" });

    expect(result.success).toBe(true);
    expect(state.responseUpdatePayload?.answers).toEqual({
      q_stale: "A",
      q_txt: "novo",
    });
    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({
      q_stale: "h-stale-old",
      q_txt: "h-text",
    });
    expect(state.assignmentUpdatePayload?.status).toBe("em_andamento");
  });

  it("auto-save em doc codificado antes do bump NAO passa a dever o campo novo (#520)", async () => {
    // Critério de aceite da #520: a codificação foi completa à época; o schema
    // ganhou um obrigatório depois. Basta o pesquisador reabrir o doc e tocar
    // qualquer coisa para o save reestampar o mapa — e a leitura retroativa
    // (backlog, reconciliação) passar a considerar a codificação incompleta.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q_novo", type: "single", required: true, options: ["x"], hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    const result = await saveResponse(
      "proj-1",
      "doc-1",
      { q1: "b" },
      { isAutoSave: true },
    );

    expect(result.success).toBe(true);
    const gravado = state.responseUpdatePayload?.answer_field_hashes as AnswerFieldHashes;
    expect(gravado).toEqual({ q1: "h1" });
    // A leitura retroativa continua enxergando a codificação como completa.
    expect(
      isCodingComplete(
        state.pydanticFields as PydanticField[],
        state.responseUpdatePayload?.answers as Record<string, unknown>,
        gravado,
      ),
    ).toBe(true);
  });

  it("campo criado depois entra no mapa quando o pesquisador o responde (#520)", async () => {
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q_novo", type: "single", required: true, options: ["x"], hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a", q_novo: "x" });

    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({
      q1: "h1",
      q_novo: "h-novo",
    });
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
  });

  it("response legacy conserva o sentinela em vez de ganhar chaves (#520)", async () => {
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q_novo", type: "single", required: true, options: ["x"], hash: "h-novo" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: null,
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "b" }, { isAutoSave: true });

    expect(state.responseUpdatePayload?.answer_field_hashes).toEqual({});
  });

  it("codificacao nova estampa o schema atual inteiro (INSERT)", async () => {
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
      { name: "q2", type: "text", required: true, hash: "h2" },
    ];

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { isAutoSave: true });

    expect(state.responseInsertPayload?.answer_field_hashes).toEqual({
      q1: "h1",
      q2: "h2",
    });
  });

  it("response legacy preserva a proveniencia de schema ja gravada (#520)", async () => {
    // Conservar o sentinela `{}` joga a leitura de staleness no fallback do
    // schema inteiro (`isFieldStale`), que compara `pydantic_hash`. Promover a
    // coluna no mesmo save tornaria esse fallback permissivo — a codificacao
    // antiga passaria a ser lida como feita contra o schema de hoje, e nenhum
    // campo apareceria stale. Omitir as colunas preserva o que esta na linha.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: null,
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "b" }, { isAutoSave: true });

    const payload = state.responseUpdatePayload ?? {};
    expect(payload).not.toHaveProperty("pydantic_hash");
    expect(payload).not.toHaveProperty("schema_version_major");
    expect(payload).not.toHaveProperty("schema_version_minor");
    expect(payload).not.toHaveProperty("schema_version_patch");
    expect(payload).not.toHaveProperty("version_inferred_from");
    // O resto do save segue normal.
    expect(payload.answers).toEqual({ q1: "b" });
  });

  it("response com proveniencia per-campo promove as colunas de versao", async () => {
    // Controle do guard acima: com o mapa herdado nao vazio, a leitura de
    // staleness usa o snapshot per-campo e as colunas de versao devem
    // acompanhar o schema de hoje como sempre.
    state.pydanticFields = [
      { name: "q1", type: "single", required: true, options: ["a", "b"], hash: "h1" },
    ];
    state.existingResponse = {
      id: "resp-1",
      is_partial: false,
      answers: { q1: "a" },
      answer_field_hashes: { q1: "h1" },
    };

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "b" }, { isAutoSave: true });

    expect(state.responseUpdatePayload?.pydantic_hash).toBe("hash-1");
    expect(state.responseUpdatePayload?.schema_version_major).toBe(1);
    expect(state.responseUpdatePayload?.version_inferred_from).toBe("live_save");
  });

  it("codificacao nova com mapa vazio ainda promove as colunas de versao (INSERT)", async () => {
    // O guard e so para response existente. Num projeto sem campos o mapa sai
    // vazio sem que isso signifique "legacy": nao ha proveniencia anterior a
    // preservar, e omitir as colunas gravaria a linha nova sem vinculo algum
    // com o schema. Este e o unico cenario que distingue o `!!existing`.
    state.pydanticFields = [];

    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", {}, { isAutoSave: true });

    expect(state.responseInsertPayload?.answer_field_hashes).toEqual({});
    expect(state.responseInsertPayload?.pydantic_hash).toBe("hash-1");
    expect(state.responseInsertPayload?.schema_version_major).toBe(1);
    expect(state.responseInsertPayload?.version_inferred_from).toBe("live_save");
  });

  it("auto-save com campo obrigatorio vazio mantem pendente em em_andamento", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "" }, { isAutoSave: true });
    expect(state.assignmentUpdatePayload?.status).toBe("em_andamento");
  });

  it("auto-save NAO regride um assignment ja concluido para em_andamento", async () => {
    state.currentAssignmentStatus = "concluido";
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "" }, { isAutoSave: true });
    // Nao deve ter chamado update em assignments (status nao muda).
    expect(state.assignmentUpdatePayload).toBeNull();
  });

  it("auto-save NAO dispara revalidatePath nem revalidateTag", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { isAutoSave: true });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("submit explicito dispara revalidatePath e revalidateTag das rotas relevantes", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/analyze/code");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/analyze/compare");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/reviews");
    expect(revalidateTag).toHaveBeenCalledWith("project-proj-1-progress", { expire: 60 });
  });

  it("opts.notes serializa em justifications._notes", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, { notes: "comentario" });
    expect(state.responseInsertPayload?.justifications).toEqual({
      _notes: "comentario",
    });
  });
});

describe("saveResponse — documento excluído (fora do escopo aprovado)", () => {
  it("rejeita save quando o doc tem excluded_at", async () => {
    state.documentExcludedAt = "2026-07-01T00:00:00Z";
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(r).toEqual({
      success: false,
      error: "Documento removido do escopo do projeto",
    });
    expect(state.responseInsertPayload).toBeNull();
    expect(state.responseUpdatePayload).toBeNull();
  });

  it("pedido apenas PENDENTE não bloqueia o save (reversível)", async () => {
    // O guard olha só excluded_at; pendência não impede persistir dado humano.
    state.documentExcludedAt = null;
    const saveResponse = await loadSaveResponse();
    const r = await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(r.success).toBe(true);
  });
});
