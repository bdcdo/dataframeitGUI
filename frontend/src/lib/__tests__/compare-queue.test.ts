import { afterEach, describe, it, expect, vi } from "vitest";
import { loadCompareQueue, type CompareQueueIdentity } from "@/lib/compare-queue";
import type { PydanticField } from "@/lib/types";
import { fieldCommentCountOf } from "@/components/compare/compare-page-view";
import { makeHumanResponse, makeProjectRow } from "@/test-utils/comparison-fixtures";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import { makeFilterAwareSupabaseMock, type QueryError, type ReadCall } from "@/test-utils/supabase-mock";

// A fila de comparação entra pelo carregador (#751): as buscas vão a um banco
// de mentira filtrado como o PostgREST, e o teste confere as props que chegam
// a <ComparePage>. Cada linha declara as colunas que a query filtra (ver
// `makeFilterAwareSupabaseMock`); o filtro do recurso embutido
// (`documents.excluded_at`) é a coluna com esse nome na linha da resposta.

const PROJECT = "p1";

// Os casos de erro silenciam o console.error com spy; ele não vaza para o
// teste seguinte.
afterEach(() => vi.restoreAllMocks());

let fieldIdSeq = 0;
function nextFieldId(): string {
  fieldIdSeq += 1;
  return `00000000-0000-4000-8000-0000000000${String(fieldIdSeq).padStart(2, "0")}`;
}

function field(overrides: Partial<PydanticField>): PydanticField {
  return {
    id: nextFieldId(),
    name: "x",
    type: "text",
    options: null,
    description: "",
    target: "all",
    hash: `h-${overrides.name ?? "x"}`,
    ...overrides,
  };
}

type Row = Record<string, unknown>;

// Resposta como a query de `responses` a devolve: a humana das fixtures
// compartilhadas (já com as colunas que a query filtra) mais o que só a fila
// seleciona, inclusive o join `documents`.
function response(overrides: Row = {}): Row {
  const documentId = (overrides.document_id as string | undefined) ?? "doc1";
  return {
    ...makeHumanResponse("user-ana", "x", { id: "r1", answers: { a: "x" } }),
    respondent_name: "Ana",
    justifications: null,
    created_at: "2026-01-01T00:00:00.000Z",
    documents: { id: documentId, title: `T-${documentId}`, external_id: null },
    ...overrides,
  };
}

// Um par de respostas humanas (Ana/u1 e Bia/u2), por padrão divergente no
// campo `a`.
function divergentPair(documentId: string, first: Row = { a: "alpha" }, second: Row = { a: "beta" }): Row[] {
  return [
    response({ id: `${documentId}-r1`, document_id: documentId, respondent_id: "u1", answers: first }),
    response({
      id: `${documentId}-r2`,
      document_id: documentId,
      respondent_id: "u2",
      respondent_name: "Bia",
      answers: second,
    }),
  ];
}

// Veredito como a query de `reviews` o devolve; por padrão, da identidade
// "me" no campo `a` do doc1.
function review(overrides: Row = {}): Row {
  return {
    document_id: "doc1",
    field_name: "a",
    verdict: "alpha",
    chosen_response_id: "doc1-r1",
    comment: null,
    reviewer_id: "me",
    field_hash: null,
    ...overrides,
  };
}

interface Seed {
  fields?: PydanticField[];
  project?: Row;
  responses?: Row[];
  // Documentos ativos, por padrão os que aparecem nas respostas.
  documents?: Row[];
  assignments?: Row[];
  reviews?: Row[];
  comments?: Row[];
  suggestions?: Row[];
  equivalences?: Row[];
  versionLog?: Row[];
}

function tables(seed: Seed): Record<string, unknown[]> {
  const responses = seed.responses ?? [];
  const docIds = [...new Set(responses.map((r) => r.document_id as string))];
  const withProject = (rows: Row[] = []) => rows.map((r) => ({ project_id: PROJECT, ...r }));
  return {
    projects: [makeProjectRow({ pydantic_fields: seed.fields ?? [field({ name: "a" })], ...seed.project })],
    responses,
    documents:
      seed.documents ??
      docIds.map((id) => ({ id, text: `texto ${id}`, excluded_at: null, exclusion_pending_at: null })),
    schema_change_log: withProject(seed.versionLog),
    assignments: withProject(seed.assignments),
    value_equivalences: withProject(seed.equivalences),
    reviews: withProject(seed.reviews),
    project_comments: withProject(seed.comments),
    schema_suggestions: withProject(seed.suggestions),
  };
}

type MockClient = ReturnType<typeof makeFilterAwareSupabaseMock>;

function client(
  tableData: Record<string, unknown[]>,
  queryErrors?: Record<string, QueryError>,
  readCalls?: ReadCall[],
): MockClient {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls: [], queryErrors, readCalls });
}

type Builder = Record<string, unknown> & {
  limit: (n: number) => unknown;
  in: (c: string, v: unknown[]) => unknown;
  range: (from: number, to: number) => unknown;
};

// Embrulha o mock, deixando `patch` trocar métodos do builder de cada leitura.
function patchReads(base: MockClient, patch: (table: string, builder: Builder) => void): MockClient {
  return {
    ...base,
    from: (table: string) => {
      const builder = base.from(table) as Builder;
      patch(table, builder);
      return builder;
    },
  };
}

// O PostgREST corta toda leitura em `max_rows` (1000), mesmo com `.limit()`
// maior, e não avisa. O mock não corta: este embrulho corta, para que leitura
// sem paginação saia truncada aqui como sai em produção.
const MAX_ROWS = 1000;
const withMaxRows = (base: MockClient) =>
  patchReads(base, (_table, builder) => {
    const limit = builder.limit;
    builder.limit = (n) => limit(Math.min(n, MAX_ROWS));
    limit(MAX_ROWS);
  });

// Falha uma leitura no meio do caminho: a página (`.range`) de `table` cujo
// início e cujo lote (`.in`) satisfazem `when`. As anteriores dão certo.
type ReadPosition = { from: number; ids: readonly unknown[] | null };
const failingRead = (table: string, when: (read: ReadPosition) => boolean) => (base: MockClient) =>
  patchReads(base, (t, builder) => {
    if (t !== table) return;
    let ids: readonly unknown[] | null = null;
    const { in: inFilter, range } = builder;
    builder.in = (c, v) => {
      ids = v;
      return inFilter(c, v);
    };
    builder.range = (from, to) =>
      when({ from, ids }) ? Promise.resolve({ data: null, error: { message: "falha no meio" } }) : range(from, to);
  });
const secondPage = (read: ReadPosition) => read.from >= 1000;
const batchWith = (docId: string) => (read: ReadPosition) => read.ids?.includes(docId) ?? false;

const COORDINATOR: CompareQueueIdentity = {
  ownMemberUserId: "me",
  queueUserId: "me",
  isImpersonating: false,
  isCoordinator: true,
};

// Aba "Todos", todas as versões: a fila sem recorte por atribuição nem versão,
// com os pisos do projeto (2 humanos, 2 respostas, 50% dos atribuídos).
const ALL_QUEUE = { queue: "all", version: "all" };

async function load(
  seed: Seed,
  opts: {
    searchParams?: Record<string, string | undefined>;
    identity?: CompareQueueIdentity;
    queryErrors?: Record<string, QueryError>;
    readCalls?: ReadCall[];
    wrap?: (base: MockClient) => MockClient;
  } = {},
) {
  const base = withMaxRows(client(tables(seed), opts.queryErrors, opts.readCalls));
  return loadCompareQueue(
    (opts.wrap ? opts.wrap(base) : base) as never,
    PROJECT,
    Promise.resolve(opts.identity ?? COORDINATOR),
    opts.searchParams ?? ALL_QUEUE,
  );
}

async function loadProps(...args: Parameters<typeof load>) {
  const result = await load(...args);
  if (!result.ok) throw new Error(result.error);
  return result.props;
}

const ids = (props: Awaited<ReturnType<typeof loadProps>>) => props.documents.map((d) => d.id);

describe("loadCompareQueue: a fila final", () => {
  it("monta documentos, ordem e contagens, reviewedCount incluído", async () => {
    const first = { a: "1", b: "1", c: "1" };
    const mine = (field_name: string) =>
      review({ document_id: "low", field_name, verdict: "1", chosen_response_id: "low-r1" });
    const fields = [field({ name: "a" }), field({ name: "b" }), field({ name: "c" })];
    const props = await loadProps({
      fields,
      project: { pydantic_hash: "hash-atual" },
      responses: [
        ...divergentPair("low", first, { a: "2", b: "2", c: "2" }),
        ...divergentPair("high", first, { a: "2", b: "2", c: "1" }),
      ],
      reviews: [mine("a"), mine("b")],
    });

    // `low` tem mais divergências (3 contra 2) e vem antes nas respostas, mas
    // 2 delas já foram revisadas: sobra 1 pendente, contra 2 de `high`.
    expect(ids(props)).toEqual(["high", "low"]);
    expect(props.documents[0]).toEqual({ id: "high", title: "T-high", external_id: null, text: "texto high" });
    expect(props.divergentFields).toEqual({ low: ["a", "b", "c"], high: ["a", "b"] });
    expect(props.coverageByDoc).toEqual({
      low: {
        docId: "low", humanCount: 2, totalCount: 2, assignedCodingCount: 0, humansFromAssigned: 0,
        divergentCount: 3, reviewedCount: 2, assignmentStatus: null,
      },
      high: {
        docId: "high", humanCount: 2, totalCount: 2, assignedCodingCount: 0, humansFromAssigned: 0,
        divergentCount: 2, reviewedCount: 0, assignmentStatus: null,
      },
    });
    expect(props.responses.low.map((r) => r.id)).toEqual(["low-r1", "low-r2"]);
    expect(Object.keys(props.existingReviews.low)).toEqual(["a", "b"]);
    expect(props.fields).toEqual(fields);
    expect(props.projectPydanticHash).toBe("hash-atual");
  });

  it("sem respostas, a fila sai vazia", async () => {
    const props = await loadProps({});
    expect(props.documents).toEqual([]);
    expect(props.responses).toEqual({});
    expect(props.coverageByDoc).toEqual({});
    expect(props.respondentNames).toEqual([]);
  });

  it("documento arquivado ou com exclusão pendente fica fora da fila", async () => {
    const archived = divergentPair("arquivado").map((r) => ({ ...r, "documents.excluded_at": "2026-06-01T00:00:00Z" }));
    const pending = divergentPair("pendente").map((r) => ({
      ...r,
      "documents.exclusion_pending_at": "2026-06-01T00:00:00Z",
    }));
    const props = await loadProps({ responses: [...divergentPair("ativo"), ...archived, ...pending] });
    expect(ids(props)).toEqual(["ativo"]);
    expect(Object.keys(props.coverageByDoc)).toEqual(["ativo"]);
    expect(Object.keys(props.responses)).toEqual(["ativo"]);
  });

  it("documento arquivado entre as duas buscas sai da lista: o texto ativo é o portão final", async () => {
    const props = await loadProps({
      responses: [...divergentPair("doc1"), ...divergentPair("doc2")],
      documents: [
        { id: "doc1", text: "texto do doc1", excluded_at: null, exclusion_pending_at: null },
        { id: "doc2", text: "texto do doc2", excluded_at: "2026-06-01T00:00:00Z", exclusion_pending_at: null },
      ],
    });
    expect(props.documents).toEqual([{ id: "doc1", title: "T-doc1", external_id: null, text: "texto do doc1" }]);
  });

  it("agrupa as respostas por documento; resposta sem o join `documents` não leva o documento à fila", async () => {
    const props = await loadProps({
      responses: [...divergentPair("doc1"), ...divergentPair("doc2").map((r) => ({ ...r, documents: null }))],
    });
    expect(ids(props)).toEqual(["doc1"]);
    expect(props.responses.doc1.map((r) => r.id)).toEqual(["doc1-r1", "doc1-r2"]);
    expect(props.responses.doc2).toBeUndefined();
  });

  it("identidade que falha derruba o carregador, mesmo com uma fonte em erro", async () => {
    await expect(
      loadCompareQueue(
        client(tables({}), { "responses:select": { message: "boom" } }) as never,
        PROJECT,
        Promise.reject(new Error("sem identidade")),
        ALL_QUEUE,
      ),
    ).rejects.toThrow("sem identidade");
  });
});

describe("loadCompareQueue: fila pessoal contra todos", () => {
  const seed: Seed = {
    responses: [...divergentPair("doc1"), ...divergentPair("doc2"), ...divergentPair("doc3")],
    assignments: [
      { document_id: "doc1", user_id: "me", type: "comparacao", status: "em_andamento" },
      { document_id: "doc2", user_id: "me", type: "comparacao", status: "concluido" },
      { document_id: "doc3", user_id: "outro", type: "comparacao", status: "pendente" },
      // atribuição de codificação não põe o doc na fila pessoal de comparação
      // (u1 e u2, que responderam, mantêm o doc acima do piso de % atribuídos)
      ...["me", "u1", "u2"].map((user_id) => ({
        document_id: "doc3", user_id, type: "codificacao", status: "pendente",
      })),
    ],
  };

  it("na aba \"Meus\" só entram os docs com comparação atribuída à identidade, com o status dela", async () => {
    const props = await loadProps(seed, { searchParams: { version: "all" } });
    expect(ids(props).toSorted()).toEqual(["doc1", "doc2"]);
    expect(props.coverageByDoc.doc1.assignmentStatus).toBe("em_andamento");
    expect(props.coverageByDoc.doc2.assignmentStatus).toBe("concluido");
    expect(props.queueContext).toEqual({ showingAll: false, hasAssignedDocs: true, isImpersonating: false });
  });

  it("na aba \"Todos\" entram todos, sem status individual de referência", async () => {
    const props = await loadProps(seed);
    expect(ids(props).toSorted()).toEqual(["doc1", "doc2", "doc3"]);
    expect(Object.values(props.coverageByDoc).map((c) => c.assignmentStatus)).toEqual([null, null, null]);
    expect(props.queueContext).toEqual({ showingAll: true, hasAssignedDocs: false, isImpersonating: false });
  });

  it("não-coordenador que pede \"Todos\" pela URL continua na fila pessoal", async () => {
    const props = await loadProps(seed, { identity: { ...COORDINATOR, isCoordinator: false } });
    expect(ids(props).toSorted()).toEqual(["doc1", "doc2"]);
    expect(props.queueContext.showingAll).toBe(false);
    expect(props.isCoordinator).toBe(false);
    expect(props.canManageAnyPair).toBe(false);
  });

  it("sem nada atribuído, a aba \"Meus\" sai vazia e diz que não há atribuição", async () => {
    const props = await loadProps(seed, {
      searchParams: { version: "all" },
      identity: { ...COORDINATOR, ownMemberUserId: "ninguem", queueUserId: "ninguem" },
    });
    expect(props.documents).toEqual([]);
    expect(props.queueContext.hasAssignedDocs).toBe(false);
  });

  it("na impersonação, a fila e o progresso são do membro impersonado e quem escreve é o master", async () => {
    const props = await loadProps(
      {
        ...seed,
        reviews: [
          review({ document_id: "doc3", chosen_response_id: "doc3-r1", reviewer_id: "outro" }),
          review({ document_id: "doc3", verdict: "beta", chosen_response_id: "doc3-r2" }),
        ],
      },
      {
        searchParams: { version: "all" },
        identity: { ownMemberUserId: "me", queueUserId: "outro", isImpersonating: true, isCoordinator: true },
      },
    );
    expect(ids(props)).toEqual(["doc3"]);
    expect(props.coverageByDoc.doc3).toMatchObject({ assignmentStatus: "pendente", reviewedCount: 1 });
    expect(props.existingReviews.doc3.a.verdict).toBe("alpha");
    expect(props.currentUserId).toBe("me");
    expect(props.queueContext.isImpersonating).toBe(true);
  });
});

describe("loadCompareQueue: qualificação do documento", () => {
  it("doc com 2 respostas divergentes e cobertura suficiente entra na fila", async () => {
    const props = await loadProps({ responses: divergentPair("doc1") });
    expect(ids(props)).toEqual(["doc1"]);
    expect(props.divergentFields.doc1).toEqual(["a"]);
    expect(props.coverageByDoc.doc1).toMatchObject({ humanCount: 2, totalCount: 2, divergentCount: 1, reviewedCount: 0 });
  });

  it("abaixo do piso de humanos, o doc é descartado", async () => {
    const props = await loadProps({ responses: [response({ id: "r1" })] });
    expect(props.documents).toEqual([]);
  });

  it("sem divergência entre as respostas, o doc é descartado", async () => {
    const props = await loadProps({
      responses: [
        response({ id: "r1", answers: { a: "alpha" } }),
        response({ id: "r2", respondent_id: "u2", answers: { a: "alpha" } }),
      ],
    });
    expect(props.documents).toEqual([]);
  });

  it("divergência fundida por equivalência registrada tira o doc da fila", async () => {
    const props = await loadProps({
      responses: divergentPair("doc1"),
      equivalences: [{ id: "eq1", field_name: "a", field_hash: "h-a", value_a: "alpha", value_b: "beta", reviewer_id: "rev" }],
    });
    expect(props.documents).toEqual([]);
  });

  it("compare_llm (piso de 1 humano): não exige % de atribuídos mesmo com atribuídos em codificação", async () => {
    // Só 1 humano respondeu de 2 atribuídos (50% < piso), mas com piso de
    // humanos < 2 o gate de % atribuídos não se aplica.
    const props = await loadProps({
      project: { automation_mode: "compare_llm" },
      responses: [
        response({ id: "r1", respondent_id: "u1", answers: { a: "alpha" } }),
        response({ id: "r2", respondent_type: "llm", respondent_name: "LLM", respondent_id: null, answers: { a: "beta" } }),
      ],
      assignments: [
        { document_id: "doc1", user_id: "u1", type: "codificacao", status: "concluido" },
        { document_id: "doc1", user_id: "u2", type: "codificacao", status: "pendente" },
      ],
    });
    expect(ids(props)).toEqual(["doc1"]);
    expect(props.defaultMinHumans).toBe(1);
    expect(props.coverageByDoc.doc1).toMatchObject({ assignedCodingCount: 2, humansFromAssigned: 1 });
  });

  it("piso de humanos >= 2: % de atribuídos abaixo do piso rejeita o doc mesmo com humanos e total suficientes", async () => {
    // 2 humanos respondem, mas só 1 dos 4 atribuídos (25% < 50%).
    const props = await loadProps({
      responses: [
        response({ id: "r1", respondent_id: "u1", answers: { a: "alpha" } }),
        response({ id: "r2", respondent_id: "u5", respondent_name: "Bia", answers: { a: "beta" } }),
      ],
      assignments: ["u1", "u2", "u3", "u4"].map((user_id) => ({
        document_id: "doc1", user_id, type: "codificacao", status: "pendente",
      })),
    });
    expect(props.documents).toEqual([]);
  });

  it("só atribuição de codificação conta como atribuído (a de comparação não)", async () => {
    const props = await loadProps({
      responses: divergentPair("doc1"),
      assignments: [
        { document_id: "doc1", user_id: "u1", type: "codificacao", status: "concluido" },
        { document_id: "doc1", user_id: "u2", type: "codificacao", status: "concluido" },
        { document_id: "doc1", user_id: "u3", type: "comparacao", status: "pendente" },
      ],
    });
    expect(props.coverageByDoc.doc1).toMatchObject({ assignedCodingCount: 2, humansFromAssigned: 2 });
  });

  it("filtro since descarta respostas anteriores à data", async () => {
    const props = await loadProps(
      {
        responses: [
          response({ id: "r1", answers: { a: "alpha" }, created_at: "2026-01-01T00:00:00.000Z" }),
          response({ id: "r2", respondent_id: "u2", answers: { a: "beta" }, created_at: "2026-06-01T00:00:00.000Z" }),
        ],
      },
      { searchParams: { ...ALL_QUEUE, since: "2026-03-01" } },
    );
    // só a resposta de junho sobrevive ao filtro — cai abaixo do total de 2
    expect(props.documents).toEqual([]);
  });

  it("filtro respondent restringe a um único respondente nomeado", async () => {
    const props = await loadProps(
      {
        responses: [
          response({ id: "r1", respondent_name: "Ana", answers: { a: "alpha" } }),
          response({ id: "r2", respondent_id: "u2", respondent_name: "Bia", answers: { a: "beta" } }),
        ],
      },
      { searchParams: { ...ALL_QUEUE, respondent: "Ana" } },
    );
    // só Ana qualifica — cai abaixo do total de 2
    expect(props.documents).toEqual([]);
  });

  it("por padrão a fila fica na major corrente do projeto", async () => {
    const v = (major: number, minor: number) => ({
      schema_version_major: major, schema_version_minor: minor, schema_version_patch: 0,
    });
    const props = await loadProps(
      {
        project: v(2, 1),
        responses: [
          ...divergentPair("atual").map((r) => ({ ...r, ...v(2, 0) })),
          ...divergentPair("antiga").map((r) => ({ ...r, ...v(1, 3) })),
        ],
      },
      { searchParams: { queue: "all" } },
    );
    expect(ids(props)).toEqual(["atual"]);
    expect(props.defaultVersion).toBe("latest_major");
    expect(props.latestMajorLabel).toBe("2.0.0");
    expect(props.currentProjectVersion).toBe("2.1.0");
  });
});

describe("loadCompareQueue: o que vai junto da fila", () => {
  it("respondentNames deduplica, ignora nome vazio e vem do conjunto todo, antes de filtrar", async () => {
    const props = await loadProps({
      responses: [
        ...divergentPair("doc1"),
        response({ id: "r3", document_id: "doc2", respondent_name: "Ana" }),
        response({ id: "r4", document_id: "doc2", respondent_name: "Caio" }),
        response({ id: "r5", document_id: "doc2", respondent_name: null }),
      ],
    });
    expect(ids(props)).toEqual(["doc1"]);
    expect(props.respondentNames.toSorted()).toEqual(["Ana", "Bia", "Caio"]);
  });

  it("availableVersions une o log de schema e as respostas, sem nulos, em ordem decrescente", async () => {
    const props = await loadProps({
      versionLog: [
        { version_major: 1, version_minor: 0, version_patch: 0 },
        { version_major: 0, version_minor: 2, version_patch: 0 },
        { version_major: null, version_minor: null, version_patch: null },
      ],
      responses: [
        response({ id: "r1", schema_version_major: 0, schema_version_minor: 1, schema_version_patch: 0 }),
        // versão já coberta pelo log — não duplica
        response({ id: "r2", schema_version_major: 1, schema_version_minor: 0, schema_version_patch: 0 }),
        // sem versão gravada — ignorada
        response({ id: "r3" }),
      ],
    });
    expect(props.availableVersions).toEqual(["1.0.0", "0.2.0", "0.1.0"]);
  });

  it("conta comentários abertos por (doc, campo) e sugestões pendentes por campo", async () => {
    const props = await loadProps({
      responses: divergentPair("doc1"),
      comments: [
        { document_id: "doc1", field_name: "a", resolved_at: null },
        { document_id: "doc1", field_name: "a", resolved_at: null },
        { document_id: "doc1", field_name: "b", resolved_at: null },
        { document_id: null, field_name: "b", resolved_at: null },
        { document_id: "doc1", field_name: "c", resolved_at: "2026-01-01T00:00:00Z" },
      ],
      suggestions: [
        { field_name: "a", status: "pending" },
        { field_name: "a", status: "pending" },
        { field_name: "c", status: "pending" },
        { field_name: "d", status: "accepted" },
      ],
    });
    expect(props.commentCountsByKey).toEqual({ "doc1|a": 2, "doc1|b": 1 });
    expect(props.suggestionCountsByField).toEqual({ a: 2, c: 1 });
  });

  it("equivalências vão ao cliente por campo, só as da versão atual da pergunta", async () => {
    const e1 = { id: "e1", field_name: "a", field_hash: "h-a", value_a: "x", value_b: "y", reviewer_id: "u1" };
    const e2 = { id: "e2", field_name: "b", field_hash: "h-b", value_a: "z", value_b: "w", reviewer_id: null };
    const stale = { id: "e3", field_name: "b", field_hash: "h-velho", value_a: "p", value_b: "q", reviewer_id: null };
    const gone = { id: "e4", field_name: "removido", field_hash: "h", value_a: "p", value_b: "q", reviewer_id: null };
    const props = await loadProps({
      fields: [field({ name: "a" }), field({ name: "b" })],
      equivalences: [e1, e2, stale, gone],
    });
    expect(props.equivalencesByField).toEqual({
      a: [expect.objectContaining(e1)],
      b: [expect.objectContaining(e2)],
    });
  });
});

describe("loadCompareQueue: vereditos e reviewedCount", () => {
  const twoFields = [field({ name: "a" }), field({ name: "b" })];
  const docWithTwoDivergences = divergentPair("doc1", { a: "1", b: "1" }, { a: "2", b: "2" });

  it("existingReviews e reviewedCount só com os vereditos da identidade efetiva", async () => {
    const props = await loadProps({
      fields: twoFields,
      responses: docWithTwoDivergences,
      reviews: [
        review({ verdict: "1" }),
        review({ field_name: "b", verdict: "2", chosen_response_id: "doc1-r2", comment: "ok", reviewer_id: "outro" }),
      ],
    });
    expect(props.existingReviews.doc1.a.verdict).toBe("1");
    // veredito de outro revisor NÃO semeia a tela do usuário atual
    expect(props.existingReviews.doc1.b).toBeUndefined();
    expect(props.coverageByDoc.doc1.reviewedCount).toBe(1);
  });

  it("doc coberto só por vereditos de terceiros continua inteiramente pendente para o usuário", async () => {
    // Regressão do bug de 2026-07-10: docs 100% revisados por OUTRO revisor
    // apareciam como "Revisão concluída" para quem nunca os revisou.
    const props = await loadProps({
      fields: twoFields,
      responses: docWithTwoDivergences,
      reviews: [
        review({ reviewer_id: "coordenador" }),
        review({ field_name: "b", reviewer_id: "coordenador" }),
      ],
    });
    expect(props.existingReviews.doc1).toBeUndefined();
    expect(props.coverageByDoc.doc1.reviewedCount).toBe(0);
  });

  it("doc sem nenhum veredito da identidade conta 0", async () => {
    const props = await loadProps({ fields: twoFields, responses: docWithTwoDivergences });
    expect(props.coverageByDoc.doc1.reviewedCount).toBe(0);
  });

  it("veredito de campo que não diverge não conta no reviewedCount", async () => {
    const props = await loadProps({
      fields: twoFields,
      responses: divergentPair("doc1", { a: "1", b: "igual" }, { a: "2", b: "igual" }),
      reviews: [review({ field_name: "b", verdict: "igual" })],
    });
    expect(props.coverageByDoc.doc1).toMatchObject({ divergentCount: 1, reviewedCount: 0 });
    expect(props.existingReviews.doc1.b.verdict).toBe("igual");
  });

  describe("veredito vale enquanto a pergunta não muda (#758)", () => {
    const fields = [field({ name: "a", type: "single", options: ["Sim", "Não"], hash: "novo00000000" })];
    const responses = divergentPair("doc1", { a: "Sim" }, { a: "Não" });
    const mine = (overrides: Row) => review({ verdict: "Sim", comment: "antes", ...overrides });

    it("veredito da mesma pergunta, de qualquer rodada, conta como revisado", async () => {
      const props = await loadProps({ fields, responses, reviews: [mine({ field_hash: "novo00000000" })] });
      expect(props.existingReviews.doc1.a.verdict).toBe("Sim");
      expect(props.staleReviews?.doc1).toBeUndefined();
      expect(props.coverageByDoc.doc1.reviewedCount).toBe(1);
    });

    it("resposta nova digitada com o hash atual conta como revisada, mesmo fora das opções", async () => {
      const props = await loadProps({
        fields,
        responses,
        reviews: [mine({ field_hash: "novo00000000", verdict: "Não houve", chosen_response_id: null })],
      });
      expect(props.existingReviews.doc1.a.verdict).toBe("Não houve");
      expect(props.coverageByDoc.doc1.reviewedCount).toBe(1);
    });

    it.each([
      ["pergunta alterada", { field_hash: "velho0000000" }, "Sim", "pergunta_alterada"],
      ["veredito fora das opções atuais", { field_hash: null, verdict: "Talvez" }, "Talvez", "fora_do_dominio"],
    ])(
      "%s: a célula volta a pedir arbitragem e o veredito antigo fica como referência, com o motivo",
      async (_label, overrides, verdict, reason) => {
        const props = await loadProps({ fields, responses, reviews: [mine(overrides)] });
        expect(props.existingReviews.doc1).toBeUndefined();
        expect(props.coverageByDoc.doc1.reviewedCount).toBe(0);
        expect(props.staleReviews?.doc1.a).toEqual({ verdict, chosenResponseId: "doc1-r1", comment: "antes", invalidReason: reason });
      },
    );
  });
});

describe("loadCompareQueue: leituras completas, acima do teto do PostgREST", () => {
  // 600 documentos divergentes, todos na fila pessoal de "me": 1200 respostas,
  // 1800 atribuições, 1100 vereditos de "me" (500 em documentos fora da fila)
  // e 600 de outro revisor, 1100 comentários, sugestões e entradas de log.
  // Cada fonte passa das 1000 linhas que o PostgREST devolve por leitura.
  const docIds = Array.from({ length: 600 }, (_, i) => `doc${String(i).padStart(4, "0")}`);
  const big: Seed = {
    responses: docIds.flatMap((id) => divergentPair(id)),
    assignments: docIds.flatMap((document_id) => [
      { document_id, user_id: "me", type: "comparacao", status: "em_andamento" },
      { document_id, user_id: "u1", type: "codificacao", status: "concluido" },
      { document_id, user_id: "u2", type: "codificacao", status: "concluido" },
    ]),
    reviews: [
      ...docIds.flatMap((document_id) => [
        review({ document_id, chosen_response_id: `${document_id}-r1`, reviewer_id: "outro" }),
        review({ document_id, chosen_response_id: `${document_id}-r1` }),
      ]),
      ...Array.from({ length: 500 }, (_, i) => review({ document_id: `fora${i}` })),
    ],
    // 1100 no doc0000 e 300 em documentos fora da fila, que não vão ao cliente.
    comments: [
      ...Array.from({ length: 1100 }, (_, i) => ({ id: `c${i}`, document_id: "doc0000", field_name: "a", resolved_at: null })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: `cf${i}`, document_id: `fora${i}`, field_name: "a", resolved_at: null })),
    ],
    suggestions: Array.from({ length: 1100 }, (_, i) => ({ id: `s${i}`, field_name: "a", status: "pending" })),
    versionLog: [
      ...Array.from({ length: 1099 }, () => ({ version_major: 0, version_minor: 1, version_patch: 0 })),
      { version_major: 3, version_minor: 0, version_patch: 0 },
    ],
  };
  const MINE = { version: "all" };

  it("nada é cortado: fila, cobertura, vereditos, contagens e versões vêm inteiros", async () => {
    const props = await loadProps(big, { searchParams: MINE });
    expect(ids(props).toSorted()).toEqual(docIds);
    expect(Object.keys(props.responses)).toHaveLength(600);
    expect(Object.values(props.coverageByDoc).every((c) => c.reviewedCount === 1 && c.assignmentStatus === "em_andamento")).toBe(true);
    expect(Object.keys(props.existingReviews).toSorted()).toEqual(docIds);
    expect(props.commentCountsByKey).toEqual({ "doc0000|a": 1100 });
    expect(props.suggestionCountsByField).toEqual({ a: 1100 });
    expect(props.availableVersions).toEqual(["3.0.0", "0.1.0"]);
  });

  it("textos vêm em lotes de até 100 documentos, cobrindo toda a fila", async () => {
    const readCalls: ReadCall[] = [];
    await loadProps(big, { searchParams: MINE, readCalls });
    const batches = readCalls
      .filter((c) => c.table === "documents")
      .map((c) => c.filters.find(([kind]) => kind === "in")?.[2] as string[]);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.length <= 100)).toBe(true);
    expect(batches.flat().toSorted()).toEqual(docIds);
  });

  it.each([
    ["a segunda página das respostas", "responses", secondPage],
    ["a segunda página das atribuições", "assignments", secondPage],
    ["a segunda página dos vereditos", "reviews", secondPage],
    ["a segunda página dos comentários", "project_comments", secondPage],
    ["um lote do meio dos textos", "documents", batchWith("doc0250")],
  ])("falha n%s: erro, e não uma fila parcial", async (_label, table, when) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await load(big, { searchParams: MINE, wrap: failingRead(table, when) });
    expect(result.ok).toBe(false);
  });

  it("nada qualificado: não busca texto, não leva veredito, e a fila sai vazia", async () => {
    const readCalls: ReadCall[] = [];
    const props = await loadProps({ responses: [response({ id: "r1" })], reviews: [review()] }, { readCalls });
    expect(props.documents).toEqual([]);
    expect(props.existingReviews).toEqual({});
    expect(readCalls.filter((c) => c.table === "documents")).toEqual([]);
  });
});

describe("loadCompareQueue: falha de qualquer fonte vira erro, não fila vazia", () => {
  it.each([
    "projects",
    "responses",
    "schema_change_log",
    "assignments",
    "value_equivalences",
    "documents",
    "reviews",
    "project_comments",
    "schema_suggestions",
  ])("%s: erro com código para o log, sem a mensagem do banco", async (table) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await load(
      { responses: divergentPair("doc1") },
      { queryErrors: { [`${table}:select`]: { message: "detalhe interno do banco", code: "XX000" } } },
    );
    // A copy não traz a mensagem do banco, que vai só para o log.
    expect(result).toEqual({ ok: false, error: copyWithRef("Erro ao carregar a fila de comparação. Tente novamente.") });
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(loggedLine(`[compare-queue] leitura de ${table} falhou`, { code: "XX000" }));
  });
});

describe("loadCompareQueue: vereditos só dos documentos da fila", () => {
  const fields = [field({ name: "a", type: "single", options: ["alpha", "beta"], hash: "novo00000000" })];

  it("documento fora da fila não leva veredito, válido ou obsoleto, ao cliente", async () => {
    const props = await loadProps({
      fields,
      responses: [
        ...divergentPair("naFila"),
        // sem divergência: fora da fila
        ...divergentPair("semDivergencia", { a: "alpha" }, { a: "alpha" }),
      ],
      reviews: [
        review({ document_id: "naFila", field_hash: "novo00000000" }),
        review({ document_id: "naFila", field_name: "b", field_hash: "velho0000000" }),
        review({ document_id: "semDivergencia", field_hash: "novo00000000" }),
        review({ document_id: "semDivergencia", field_name: "b", field_hash: "velho0000000" }),
        // documento sem resposta nenhuma
        review({ document_id: "outroDoc", field_hash: "novo00000000" }),
      ],
    });
    expect(ids(props)).toEqual(["naFila"]);
    expect(Object.keys(props.existingReviews)).toEqual(["naFila"]);
    expect(Object.keys(props.staleReviews ?? {})).toEqual(["naFila"]);
    expect(props.coverageByDoc.naFila.reviewedCount).toBe(1);
  });

  it("na aba \"Meus\", o veredito de documento atribuído a outra pessoa fica de fora", async () => {
    const props = await loadProps(
      {
        responses: [...divergentPair("meu"), ...divergentPair("deOutro")],
        assignments: [
          { document_id: "meu", user_id: "me", type: "comparacao", status: "pendente" },
          { document_id: "deOutro", user_id: "outro", type: "comparacao", status: "pendente" },
        ],
        reviews: [review({ document_id: "meu" }), review({ document_id: "deOutro" })],
      },
      { searchParams: { version: "all" } },
    );
    expect(ids(props)).toEqual(["meu"]);
    expect(Object.keys(props.existingReviews)).toEqual(["meu"]);
  });
});

describe("loadCompareQueue: respostas substituídas (is_latest = false)", () => {
  // Rodadas anteriores do LLM e codificações rebaixadas: nunca qualificam, mas
  // o filtro de respondente e o seletor de versão cobrem o histórico todo.
  const superseded = (overrides: Row) =>
    response({ is_latest: false, answers: { a: "antiga" }, justifications: { a: "longa" }, ...overrides });
  const latestFilter = (call: ReadCall) =>
    call.filters.find(([kind, column]) => kind === "eq" && column === "is_latest")?.[2];
  const responseReads = (readCalls: ReadCall[]) => readCalls.filter((c) => c.table === "responses");

  it("nomes e versões cobrem as substituídas; fila, respostas e cobertura só as atuais", async () => {
    const props = await loadProps({
      responses: [
        ...divergentPair("doc1"),
        superseded({
          id: "old1",
          respondent_id: "u3",
          respondent_name: "gpt-antigo",
          schema_version_major: 0,
          schema_version_minor: 1,
          schema_version_patch: 0,
        }),
        // Documento só com substituídas: não entra na fila.
        ...divergentPair("doc2").map((r) => ({ ...r, is_latest: false, respondent_name: "Dora" })),
        // Documento arquivado: fora dos nomes, como as atuais.
        superseded({ id: "old3", document_id: "arq", respondent_name: "Eva", "documents.excluded_at": "2026-06-01T00:00:00Z" }),
      ],
    });
    expect(ids(props)).toEqual(["doc1"]);
    expect(props.responses).toEqual({ doc1: [expect.objectContaining({ id: "doc1-r1" }), expect.objectContaining({ id: "doc1-r2" })] });
    expect(props.coverageByDoc.doc1).toMatchObject({ humanCount: 2, totalCount: 2 });
    expect(props.respondentNames.toSorted()).toEqual(["Ana", "Bia", "Dora", "gpt-antigo"]);
    expect(props.availableVersions).toEqual(["0.1.0"]);
  });

  it("a ordem dos nomes é a da PK, intercalando atuais e substituídas", async () => {
    const props = await loadProps({
      responses: [
        response({ id: "id-3", respondent_name: "Ana" }),
        superseded({ id: "id-1", respondent_name: "Zé" }),
        response({ id: "id-2", document_id: "doc2", respondent_name: "Bia" }),
        superseded({ id: "id-4", respondent_name: "Caio" }),
      ],
    });
    expect(props.respondentNames).toEqual(["Zé", "Bia", "Ana", "Caio"]);
  });

  it("as substituídas vêm sem answers nem justifications, com o mesmo recorte de documentos", async () => {
    const readCalls: ReadCall[] = [];
    await loadProps({ responses: [...divergentPair("doc1"), superseded({ id: "old1" })] }, { readCalls });
    const reads = responseReads(readCalls);
    const heavy = reads.filter((c) => /\b(answers|justifications)\b/.test(c.columns));
    expect(heavy.length).toBeGreaterThan(0);
    expect(heavy.every((c) => latestFilter(c) === true)).toBe(true);
    const history = reads.filter((c) => latestFilter(c) === false);
    expect(history.length).toBeGreaterThan(0);
    const documentFilters = (c: ReadCall) => c.filters.filter(([, column]) => column.startsWith("documents."));
    for (const call of history) {
      expect(call.columns).not.toMatch(/\b(answers|justifications)\b/);
      expect(documentFilters(call)).toEqual(documentFilters(heavy[0]));
    }
  });

  // 1100 substituídas, além do teto de 1000 do PostgREST: o nome da última
  // só aparece se a leitura delas pagina.
  const many = [
    ...divergentPair("doc1"),
    ...Array.from({ length: 1100 }, (_, i) =>
      superseded({ id: `old${String(i).padStart(4, "0")}`, respondent_name: i === 1099 ? "Última" : "LLM" }),
    ),
  ];

  it("mais de 1000 substituídas: a leitura pagina e nenhum nome é cortado", async () => {
    const props = await loadProps({ responses: many });
    expect(props.respondentNames.toSorted()).toEqual(["Ana", "Bia", "LLM", "Última"]);
  });

  it("falha na segunda página das substituídas: erro, e não uma lista de nomes parcial", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failSupersededSecondPage = (base: MockClient) =>
      patchReads(base, (table, builder) => {
        if (table !== "responses") return;
        let isLatest: unknown;
        const { eq, range } = builder as Builder & { eq: (c: string, v: unknown) => unknown };
        builder.eq = (c: string, v: unknown) => {
          if (c === "is_latest") isLatest = v;
          return eq(c, v);
        };
        builder.range = (from, to) =>
          isLatest === false && from >= 1000
            ? Promise.resolve({ data: null, error: { message: "falha no meio" } })
            : range(from, to);
      });
    const result = await load({ responses: many }, { wrap: failSupersededSecondPage });
    expect(result).toEqual({ ok: false, error: copyWithRef("Erro ao carregar a fila de comparação. Tente novamente.") });
  });
});

describe("loadCompareQueue: comentários só dos documentos da fila", () => {
  const open = (document_id: string | null, field_name: string | null, id: string) => ({
    id,
    document_id,
    field_name,
    resolved_at: null,
  });

  it("contagem de documento fora da fila ou sem documento não vai ao cliente; a exibida não muda", async () => {
    const props = await loadProps({
      responses: [...divergentPair("doc1"), ...divergentPair("semDivergencia", { a: "alpha" }, { a: "alpha" })],
      comments: [
        open("doc1", "a", "c1"),
        open("doc1", "a", "c2"),
        // Comentário do documento inteiro: soma em todo campo dele.
        open("doc1", null, "c3"),
        open("semDivergencia", "a", "c4"),
        open("nuncaRespondido", "a", "c5"),
        open(null, "a", "c6"),
      ],
    });
    expect(ids(props)).toEqual(["doc1"]);
    expect(props.commentCountsByKey).toEqual({ "doc1|a": 2, "doc1|": 1 });
    // O que a tela mostra para o documento da fila.
    expect(fieldCommentCountOf(props.commentCountsByKey, "doc1", "a")).toBe(3);
    expect(fieldCommentCountOf(props.commentCountsByKey, "doc1", "b")).toBe(1);
  });

  it("fila vazia: nenhuma contagem, ainda que haja comentários abertos", async () => {
    const props = await loadProps({
      responses: divergentPair("doc1", { a: "alpha" }, { a: "alpha" }),
      comments: [open("doc1", "a", "c1"), open(null, "a", "c2")],
    });
    expect(props.documents).toEqual([]);
    expect(props.commentCountsByKey).toEqual({});
  });

  it("lê comentários apenas dos documentos da fila", async () => {
    const readCalls: ReadCall[] = [];
    await loadProps({ responses: divergentPair("doc1"), comments: [open("doc1", "a", "c1"), open("fora", "a", "c2")] }, { readCalls });
    const reads = readCalls.filter((c) => c.table === "project_comments");
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toContainEqual(["in", "document_id", ["doc1"]]);
    expect(reads[0].filters).toContainEqual(["eq", "project_id", PROJECT]);
  });

  it("fila vazia não consulta comentários", async () => {
    const readCalls: ReadCall[] = [];
    await loadProps({ comments: [open("fora", "a", "c1")] }, { readCalls });
    expect(readCalls.filter((c) => c.table === "project_comments")).toEqual([]);
  });

  it("mais de cem documentos: consulta em lotes sem perder contagens", async () => {
    const docIds = Array.from({ length: 101 }, (_, i) => `doc${String(i).padStart(3, "0")}`);
    const readCalls: ReadCall[] = [];
    const props = await loadProps({
      responses: docIds.flatMap((id) => divergentPair(id)),
      comments: docIds.map((id, i) => open(id, "a", `c${i}`)),
    }, { readCalls });
    expect(Object.keys(props.commentCountsByKey)).toHaveLength(101);
    expect(props.commentCountsByKey["doc100|a"]).toBe(1);
    const reads = readCalls.filter((c) => c.table === "project_comments");
    expect(reads).toHaveLength(2);
    expect(reads.flatMap((call) => call.filters.find(([kind, column]) => kind === "in" && column === "document_id")?.[2] as string[] ?? []).toSorted()).toEqual(docIds);
  });

  it("erro em um lote de comentários falha a fila inteira", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const docIds = Array.from({ length: 101 }, (_, i) => `doc${String(i).padStart(3, "0")}`);
    const result = await load({
      responses: docIds.flatMap((id) => divergentPair(id)),
      comments: docIds.map((id, i) => open(id, "a", `c${i}`)),
    }, { wrap: failingRead("project_comments", batchWith("doc100")) });
    expect(result).toEqual({ ok: false, error: copyWithRef("Erro ao carregar a fila de comparação. Tente novamente.") });
  });
});
