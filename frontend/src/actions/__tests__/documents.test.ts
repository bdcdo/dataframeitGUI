import { describe, it, expect, beforeEach, vi } from "vitest";

// Testa o filtro de conflito com o indice unico parcial
// documents_project_external_id_active_uniq (migration 20260623130000):
// uploadDocuments nao pode mais inserir external_id ja ATIVO no projeto nem
// repetido no proprio lote, senao o INSERT em lote falharia inteiro. O mock de
// documents e uma FILA: 1a query = SELECT dos external_ids ativos existentes,
// 2a = o INSERT. Quando o lote nao tem external_id, o SELECT e pulado e o INSERT
// consome o 1o item.
import {
  makeSupabaseMock,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let serverTableResults: TableResults | undefined;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
  isProjectCoordinator: async () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: serverTableResults, writeCalls }),
}));

beforeEach(() => {
  writeCalls = [];
  serverTableResults = undefined;
});

async function loadUpload() {
  return (await import("@/actions/documents")).uploadDocuments;
}

function insertedExternalIds(): (string | null)[] {
  const call = writeCalls.find(
    (c) => c.table === "documents" && c.op === "insert",
  );
  return ((call?.payload as { external_id: string | null }[]) ?? []).map(
    (r) => r.external_id,
  );
}

describe("uploadDocuments — filtro do indice unico (add_all)", () => {
  it("pula external_id ja ATIVO no projeto e insere os demais", async () => {
    // SELECT devolve DOC-1 como ja existente ativo; depois o INSERT (sem erro).
    serverTableResults = {
      documents: [{ data: [{ external_id: "DOC-1" }] }, { error: null }],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "ja existe" },
        { external_id: "DOC-2", text: "novo a" },
        { external_id: "DOC-3", text: "novo b" },
      ],
      false,
    );

    expect(r.error).toBeUndefined();
    expect(r.count).toBe(2);
    expect(r.skipped).toBe(1);
    expect(insertedExternalIds()).toEqual(["DOC-2", "DOC-3"]);
  });

  it("pula repeticao do mesmo external_id dentro do lote (mantem a 1a)", async () => {
    serverTableResults = {
      documents: [{ data: [] }, { error: null }],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-A", text: "primeira" },
        { external_id: "DOC-A", text: "duplicata no arquivo" },
        { external_id: "DOC-B", text: "outra" },
      ],
      false,
    );

    expect(r.count).toBe(2);
    expect(r.skipped).toBe(1);
    expect(insertedExternalIds()).toEqual(["DOC-A", "DOC-B"]);
  });

  it("nunca filtra documentos sem external_id", async () => {
    // Sem external_ids no lote -> SELECT e pulado; INSERT consome o 1o item.
    serverTableResults = { documents: [{ error: null }] };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { text: "sem id 1" },
        { text: "sem id 2" },
      ],
      false,
    );

    expect(r.count).toBe(2);
    expect(r.skipped).toBe(0);
    expect(insertedExternalIds()).toEqual([null, null]);
  });
});
