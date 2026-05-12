import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath, revalidateTag } from "next/cache";

// Mocks precisam ser declarados antes do import dinamico do modulo sob teste.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => ({ id: "user-1", email: "u@test.com" })),
}));

interface State {
  responseInsertPayload: Record<string, unknown> | null;
  responseUpdatePayload: Record<string, unknown> | null;
  assignmentUpdatePayload: Record<string, unknown> | null;
  existingResponse: { id: string } | null;
  currentAssignmentStatus: string | null;
  pydanticFields: Array<{
    name: string;
    type: string;
    required?: boolean;
    options?: string[];
    target?: string;
  }>;
  schemaVersion: { major: number; minor: number; patch: number };
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
  };
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(revalidateTag).mockClear();
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
      undefined,
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
      undefined,
      // isAutoSave default = false
    );
    expect(r.success).toBe(true);
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
    expect(typeof state.assignmentUpdatePayload?.completed_at).toBe("string");
  });

  it("auto-save grava response com is_partial=true", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, undefined, {
      isAutoSave: true,
    });
    expect(state.responseInsertPayload?.is_partial).toBe(true);
  });

  it("submit explicito grava response com is_partial=false", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseInsertPayload?.is_partial).toBe(false);
  });

  it("submit apos auto-save sobrescreve is_partial: true -> false (UPDATE)", async () => {
    // Cenario: o pesquisador deu auto-save antes (response ja existe com is_partial=true)
    // e agora clica Enviar — o submit deve fazer UPDATE com is_partial=false.
    state.existingResponse = { id: "resp-1" };
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" });
    expect(state.responseUpdatePayload?.is_partial).toBe(false);
    expect(state.assignmentUpdatePayload?.status).toBe("concluido");
  });

  it("auto-save com campo obrigatorio vazio mantem pendente em em_andamento", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "" }, undefined, {
      isAutoSave: true,
    });
    expect(state.assignmentUpdatePayload?.status).toBe("em_andamento");
  });

  it("auto-save NAO regride um assignment ja concluido para em_andamento", async () => {
    state.currentAssignmentStatus = "concluido";
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "" }, undefined, {
      isAutoSave: true,
    });
    // Nao deve ter chamado update em assignments (status nao muda).
    expect(state.assignmentUpdatePayload).toBeNull();
  });

  it("auto-save NAO dispara revalidatePath nem revalidateTag", async () => {
    const saveResponse = await loadSaveResponse();
    await saveResponse("proj-1", "doc-1", { q1: "a" }, undefined, {
      isAutoSave: true,
    });
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
});
