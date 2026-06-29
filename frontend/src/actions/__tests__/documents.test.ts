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

async function loadGetDocumentText() {
  return (await import("@/actions/documents")).getDocumentText;
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

describe("uploadDocuments — contagem em add_new_only", () => {
  it("conta os duplicados do duplicateMap em skipped (count + skipped == total)", async () => {
    // SELECT do filtro nao acha nada ativo; INSERT do DOC-2 ok.
    serverTableResults = {
      documents: [{ data: [] }, { error: null }],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "ja existe no projeto" },
        { external_id: "DOC-2", text: "novo" },
      ],
      false,
      {
        mode: "add_new_only",
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "external_id" },
        ],
      },
    );

    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1);
    expect(r.skipped).toBe(1);
    expect(insertedExternalIds()).toEqual(["DOC-2"]);
  });

  it("todos duplicados -> 0 importados e skipped == total", async () => {
    // Early return: nenhuma query e disparada.
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [
        { external_id: "DOC-1", text: "x" },
        { external_id: "DOC-2", text: "y" },
      ],
      false,
      {
        mode: "add_new_only",
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "external_id" },
          { csvIndex: 1, existingDocId: "id-2", matchType: "external_id" },
        ],
      },
    );

    expect(r.count).toBe(0);
    expect(r.skipped).toBe(2);
  });
});

describe("uploadDocuments — replace_and_add propaga erro de UPDATE", () => {
  it("retorna error quando o UPDATE viola o indice unico (23505)", async () => {
    // 1a query em documents = o UPDATE do duplicado, que falha com 23505.
    serverTableResults = {
      documents: [
        {
          error: {
            message: "duplicate key value violates unique constraint",
            code: "23505",
          },
        },
      ],
    };
    const uploadDocuments = await loadUpload();

    const r = await uploadDocuments(
      "proj-1",
      [{ external_id: "DOC-1", text: "casa por hash com outro doc" }],
      false,
      {
        mode: "replace_and_add",
        duplicateMap: [
          { csvIndex: 0, existingDocId: "id-1", matchType: "text_hash" },
        ],
      },
    );

    expect(r.error).toContain("duplicate key");
    // O INSERT nao deve acontecer apos o erro do UPDATE.
    expect(
      writeCalls.some((c) => c.table === "documents" && c.op === "insert"),
    ).toBe(false);
  });
});

describe("getDocumentText", () => {
  it("retorna texto e titulo quando o doc existe", async () => {
    serverTableResults = {
      documents: [{ data: { title: "Titulo", text: "conteudo" } }],
    };
    const getDocumentText = await loadGetDocumentText();

    const r = await getDocumentText("proj-1", "doc-1");

    expect(r).toEqual({ text: "conteudo", title: "Titulo" });
  });

  it("retorna null (sem lancar) quando o doc nao existe", async () => {
    // maybeSingle devolve data:null em 0 linhas; nao pode lancar (era .single()).
    serverTableResults = { documents: [{ data: null }] };
    const getDocumentText = await loadGetDocumentText();

    await expect(getDocumentText("proj-1", "missing")).resolves.toBeNull();
  });

  it("lanca quando a query retorna erro, em vez de silenciar como nao-encontrado", async () => {
    serverTableResults = {
      documents: [{ error: { message: "rls denied", code: "42501" } }],
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const getDocumentText = await loadGetDocumentText();

    await expect(getDocumentText("proj-1", "doc-1")).rejects.toMatchObject({
      message: "rls denied",
    });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
