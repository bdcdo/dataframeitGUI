import { describe, it, expect } from "vitest";
import { fetchLatestResponses } from "@/lib/supabase/fetch-latest-responses";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

// Publicar uma resposta LLM troca a vigente do documento por uma linha nova,
// e cada página do cursor é um statement: a troca cabe entre duas páginas.
describe("fetchLatestResponses: troca de is_latest entre duas páginas", () => {
  interface Latest {
    id: string; round_id: string; document_id: string; respondent_type: "humano" | "llm"; respondent_id: string | null;
  }
  const pad = (i: number) => String(i).padStart(4, "0");
  const llm = (id: string, doc: string, createdAt = "2026-09-01T00:00:00.000Z") => ({
    id, project_id: "p1", round_id: "round-1", document_id: doc, respondent_type: "llm" as const, respondent_id: null, is_latest: true, created_at: createdAt,
  });
  // 1001 documentos, uma resposta LLM vigente em cada: a 1ª página vai de
  // r0000 a r0999 e a 2ª traz r1000.
  const seed = () => Array.from({ length: 1001 }, (_, i) => llm(`r${pad(i)}`, `d${pad(i)}`));
  // A publicação: rebaixa a vigente do documento e insere a nova, agora.
  const republish = (data: ReturnType<typeof seed>, oldId: string, newId: string) => {
    const old = data.find((row) => row.id === oldId)!;
    old.is_latest = false;
    data.push(llm(newId, old.document_id, new Date().toISOString()));
  };
  const read = (data: ReturnType<typeof seed>, betweenPages: () => void) => {
    let reads = 0;
    const mock = makeFilterAwareSupabaseMock({
      tableData: { responses: data }, writeCalls: [],
      afterRead: () => { if (++reads === 1) betweenPages(); },
    });
    return fetchLatestResponses<Latest>(mock as never, "p1", "created_at");
  };
  const docsOf = (rows: Latest[]) => rows.map((row) => row.document_id).sort();
  const everyDocOnce = seed().map((row) => row.document_id);

  it("vigente já lida e a nova depois do cursor: o documento sai uma vez, com a nova", async () => {
    const data = seed();
    const { data: rows, error } = await read(data, () => republish(data, "r0000", "r9999"));
    expect(error).toBeNull();
    expect(docsOf(rows)).toEqual(everyDocOnce);
    expect(rows.find((row) => row.document_id === "d0000")?.id).toBe("r9999");
  });

  it("vigente ainda não lida e a nova antes do cursor: o documento não some", async () => {
    const data = seed();
    const { data: rows, error } = await read(data, () => republish(data, "r1000", "r0000a"));
    expect(error).toBeNull();
    expect(docsOf(rows)).toEqual(everyDocOnce);
    expect(rows.find((row) => row.document_id === "d1000")?.id).toBe("r0000a");
  });

  it("a mesma pessoa em duas rodadas do mesmo documento são duas respostas vigentes, não uma duplicata", async () => {
    const data = seed();
    const human = (id: string, round: string) => ({ ...llm(id, "d0000"), round_id: round, respondent_type: "humano" as const, respondent_id: "ana" });
    data.push(human("h1", "round-1") as never, human("h2", "round-2") as never);
    const { data: rows } = await read(data, () => {});
    expect(rows.filter((row) => row.respondent_id === "ana").map((row) => row.id).sort()).toEqual(["h1", "h2"]);
  });

  it("lê só as vigentes do projeto: os filtros são do helper, não de quem chama", async () => {
    const data = seed().slice(0, 3);
    data[1].is_latest = false;
    data[2].project_id = "p2";
    const { data: rows } = await read(data, () => {});
    expect(rows.map((row) => row.id)).toEqual(["r0000"]);
  });

  it("menos de uma página é um statement só e não relê nada", async () => {
    let reads = 0;
    const mock = makeFilterAwareSupabaseMock({
      tableData: { responses: seed().slice(0, 10) }, writeCalls: [], afterRead: () => { reads += 1; },
    });
    const { data: rows } = await fetchLatestResponses<Latest>(mock as never, "p1", "created_at");
    expect(rows).toHaveLength(10);
    expect(reads).toBe(1);
  });

  it("erro na releitura não passa por leitura completa", async () => {
    const mock = makeFilterAwareSupabaseMock({
      tableData: { responses: seed() }, writeCalls: [],
      queryErrorForCall: ({ filters }) => filters.some(([, column]) => column === "created_at") ? { message: "gateway fora" } : undefined,
    });
    const { error } = await fetchLatestResponses<Latest>(mock as never, "p1", "created_at");
    expect(error).toEqual({ message: "gateway fora" });
  });
});
