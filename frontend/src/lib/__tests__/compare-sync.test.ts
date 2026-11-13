import { beforeAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type QueryError,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { CURRENT_HASH, makeEquivalenceRow } from "@/test-utils/comparison-fixtures";

// compare-sync.ts abre com `import "server-only"`, que LANÇA fora de um Server
// Component. Mocká-lo para no-op deixa o módulo importável no Vitest (node).
vi.mock("server-only", () => ({}));

let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError | null>;

const updateCallsOf = (table?: string) => callsOf(writeCalls, "update", table);

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls, queryErrors });
}

// O mock compartilhado registra o payload do UPDATE, não o filtro que escolheu
// a linha. Este embrulho local anota o `id` passado ao `.eq` depois de cada
// `update` em `assignments`, para o teste afirmar QUAL linha foi gravada.
function idsAtualizadosEm(client: ReturnType<typeof makeClient>) {
  const ids: unknown[] = [];
  const from = client.from;
  client.from = (table: string) => {
    const builder = from(table);
    if (table !== "assignments") return builder;
    const update = builder.update as (payload: unknown) => unknown;
    const eq = builder.eq as (coluna: string, valor: unknown) => unknown;
    let emUpdate = false;
    builder.update = (payload: unknown) => {
      emUpdate = true;
      return update(payload);
    };
    builder.eq = (coluna: string, valor: unknown) => {
      if (emUpdate && coluna === "id") ids.push(valor);
      return eq(coluna, valor);
    };
    return builder;
  };
  return ids;
}

const FIELDS: PydanticField[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "decisao",
    type: "single",
    options: ["proc", "improc"],
    description: "",
    target: "all",
  },
];

// Resposta da MAJOR corrente (qualifica sob o piso latest_major). `extra`
// sobrescreve para emular rodadas antigas / pré-versionamento.
const resp = (
  id: string,
  decisao: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  project_id: "p1",
  document_id: "doc1",
  respondent_type: "humano",
  is_latest: true,
  is_partial: false,
  pydantic_hash: CURRENT_HASH,
  schema_version_major: 2,
  schema_version_minor: 0,
  schema_version_patch: 0,
  answers: { decisao },
  answer_field_hashes: null,
  ...extra,
});

const projectRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  pydantic_fields: FIELDS,
  pydantic_hash: CURRENT_HASH,
  schema_version_major: 2,
  schema_version_minor: 0,
  schema_version_patch: 0,
  current_round_id: "r-atual",
  ...over,
});

const assignment = (status: string) => ({
  id: "a1",
  project_id: "p1",
  document_id: "doc1",
  user_id: "rev1",
  type: "comparacao",
  round_id: "r-atual",
  status,
});

beforeEach(() => {
  writeCalls = [];
  queryErrors = {};
  tableData = {
    projects: [projectRow()],
    assignments: [assignment("pendente")],
    responses: [],
    reviews: [],
    value_equivalences: [],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadLib() {
  return import("@/lib/compare-sync");
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/lib/compare-sync");
}, 30_000);

describe("syncCompareAssignment — piso de versão latest_major (#247/#286)", () => {
  // TRIP-WIRE do acoplamento visão==fecho: exercita o MÓDULO de produção (não
  // uma réplica da lógica). Reverter compare-sync.ts para o piso 'all'
  // (DEFAULT_COMPARE_FILTERS.version) faria a codificação da major antiga voltar
  // a contar, "decisao" divergir e o status NÃO virar concluido — quebrando este
  // teste. É a proteção que faltava (o achado de revisão do #286).
  it("aplica o piso: codificação de major anterior é descartada no fecho", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [
      resp("a", "proc"), // major 2 (corrente)
      resp("b", "proc"), // major 2 (corrente) — concordam
      resp("c", "improc", {
        pydantic_hash: "hash-antigo",
        schema_version_major: 1,
      }), // major 1 → abaixo do piso, descartada
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    // Sob latest_major só a/b contam → concordam → sem divergência → concluido.
    expect(updateCallsOf("assignments")).toHaveLength(1);
    expect(updateCallsOf("assignments")[0].payload).toMatchObject({
      status: "concluido",
    });
  });

  it("divergência fundida por equivalência registrada → fecha (concluido)", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.projects = [projectRow({ pydantic_fields: [{ ...FIELDS[0], hash: "decisao-hash" }] })];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.value_equivalences = [
      makeEquivalenceRow("decisao", { id: "a", answer: "proc" }, { id: "b", answer: "improc" }),
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")[0]?.payload).toMatchObject({
      status: "concluido",
    });
  });

  // A equivalência é de valor, no projeto inteiro: a decidida em outro
  // documento funde este; e a de outra versão da pergunta não funde.
  it.each([
    ["decidida em outro documento", "decisao-hash", 1],
    ["de outra versão da pergunta", "decisao-hash-antiga", 0],
  ])("equivalência de valor %s", async (_label, fieldHash, updates) => {
    const { syncCompareAssignment } = await loadLib();
    tableData.projects = [projectRow({ pydantic_fields: [{ ...FIELDS[0], hash: "decisao-hash" }] })];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.value_equivalences = [
      { ...makeEquivalenceRow("decisao", { id: "x", answer: "PROC" }, { id: "y", answer: "improc" }, fieldHash), origin_document_id: "doc9" },
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")).toHaveLength(updates);
  });

  it("divergência na major corrente, sem veredito → não fecha (em_andamento/pendente)", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    // Diverge e ninguém revisou: status alvo = pendente; como o assignment já é
    // pendente, não há update.
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  // #758: o fecho segue a mesma regra do Gabarito. Veredito dado sobre outra
  // versão da pergunta (hash diferente) ou fora das opções atuais não resolve
  // a divergência, e o parecer não fecha com uma célula que o Gabarito não tem.
  it.each([
    ["pergunta alterada", { verdict: "proc", field_hash: "velho0000000" }],
    ["veredito fora das opções atuais", { verdict: "talvez", field_hash: null }],
  ])("veredito que perdeu a validade (%s) não fecha o parecer", async (_label, stale) => {
    const { syncCompareAssignment } = await loadLib();
    tableData.projects = [projectRow({ pydantic_fields: [{ ...FIELDS[0], hash: "novo00000000" }] })];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.reviews = [
      { project_id: "p1", document_id: "doc1", reviewer_id: "rev1", field_name: "decisao", ...stale },
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  it("veredito da mesma pergunta, de rodada anterior, fecha o parecer", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.projects = [projectRow({ pydantic_fields: [{ ...FIELDS[0], hash: "novo00000000" }] })];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.reviews = [
      { project_id: "p1", document_id: "doc1", reviewer_id: "rev1", field_name: "decisao", verdict: "proc", field_hash: "novo00000000" },
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")[0].payload).toMatchObject({ status: "concluido" });
  });

  it("divergência corrente resolvida pela revisora → fecha (concluido)", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.reviews = [
      { project_id: "p1", document_id: "doc1", reviewer_id: "rev1", field_name: "decisao", verdict: "proc", field_hash: null },
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")).toHaveLength(1);
    expect(updateCallsOf("assignments")[0].payload).toMatchObject({
      status: "concluido",
    });
  });
});

describe("syncCompareAssignment — guarda de <2 respostas qualificadas (#286)", () => {
  // Sem ao menos 2 respostas qualificadas não há par a comparar; o fecho NÃO
  // deve declarar "concluido" (marcaria como revisado um doc que ninguém
  // comparou na versão corrente). Sem a guarda, 1 resposta → divergência vazia →
  // concluido espúrio. O teste falha se a guarda for removida.
  it("1 corrente + 1 pré-versionamento → só 1 qualifica → não fecha (sem update)", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [
      resp("a", "proc"), // corrente, qualifica
      resp("b", "proc", { pydantic_hash: null, schema_version_major: null }), // pré-versionamento → descartada
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  it("doc só com codificações pré-versionamento → 0 qualificam → não fecha", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [
      resp("a", "proc", { pydantic_hash: null, schema_version_major: null }),
      resp("b", "improc", { pydantic_hash: null, schema_version_major: null }),
    ];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });
});

describe("syncCompareAssignment: só a rodada corrente", () => {
  // O revisor tem comparação do documento em duas rodadas. A chave única de
  // `assignments` inclui a rodada, e sem o filtro por `current_round_id` o
  // `maybeSingle` receberia as duas linhas: o PostgREST devolve PGRST116 e o
  // mock devolve a primeira, aqui a da rodada antiga, já concluída. Só a da
  // rodada corrente deve ser lida e fechada.
  it("lê e fecha o assignment da rodada corrente, não o da rodada antiga", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.assignments = [
      { ...assignment("concluido"), id: "a-antigo", round_id: "r-antiga" },
      assignment("pendente"),
    ];
    tableData.responses = [resp("a", "proc"), resp("b", "proc")];
    const client = makeClient();
    const idsAtualizados = idsAtualizadosEm(client);

    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");

    expect(updateCallsOf("assignments").map((c) => c.payload)).toEqual([
      { status: "concluido", completed_at: expect.any(String) },
    ]);
    expect(idsAtualizados).toEqual(["a1"]);
  });

  // O erro da leitura (o PGRST116 de duas linhas, por exemplo) propaga para o
  // chamador, que o registra, em vez de virar "sem assignment" e sair em
  // silêncio.
  it("propaga erro da leitura do assignment do revisor", async () => {
    const { syncCompareAssignment } = await loadLib();
    queryErrors["assignments:select"] = {
      message: "JSON object requested, multiple (or no) rows returned",
      code: "PGRST116",
    };
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).rejects.toThrow("multiple (or no) rows returned");
  });

  it("propaga erro da leitura do projeto", async () => {
    const { syncCompareAssignment } = await loadLib();
    queryErrors["projects:select"] = {
      message: "permission denied for table projects",
      code: "42501",
    };
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).rejects.toThrow("permission denied for table projects");
  });

  // Projeto sem rodada corrente: todo assignment é histórico. O erro na
  // leitura de assignments faz o teste falhar se ela acontecer.
  it("projeto sem rodada corrente não lê nem grava assignment", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.projects = [projectRow({ current_round_id: null })];
    tableData.responses = [resp("a", "proc"), resp("b", "proc")];
    queryErrors["assignments:select"] = { message: "leitura inesperada", code: "XX000" };
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).resolves.toBeUndefined();
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });
});

describe("syncCompareAssignment — regressão de comparação histórica (#497)", () => {
  it("mantém a concluída e loga o 23505 quando outra comparação está ativa", async () => {
    const { syncCompareAssignment } = await loadLib();
    // `a2` documenta o cenário (o documento já tem outra comparação ativa), não
    // o produz: o mock não modela o índice parcial — quem força o 23505 é o
    // `queryErrors` abaixo.
    tableData.assignments = [
      assignment("concluido"),
      {
        ...assignment("pendente"),
        id: "a2",
        user_id: "rev2",
      },
    ];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    queryErrors["assignments:update"] = {
      message:
        'duplicate key value violates unique constraint "assignments_one_active_comparacao_per_doc"',
      code: "23505",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).resolves.toBeUndefined();

    expect(updateCallsOf("assignments")).toHaveLength(1);
    expect(updateCallsOf("assignments")[0].payload).toEqual({
      status: "pendente",
      completed_at: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line.startsWith("[compare-sync] ")).toBe(true);
    expect(JSON.parse(line.slice("[compare-sync] ".length))).toEqual({
      event: "regression_blocked_by_active_assignment",
      projectId: "p1",
      documentId: "doc1",
      assignmentId: "a1",
      userId: "rev1",
      previousStatus: "concluido",
      intendedStatus: "pendente",
      errorCode: "23505",
    });
  });

  it("também preserva a concluída quando a regressão pretendida é em_andamento", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.projects = [
      projectRow({
        pydantic_fields: [
          ...FIELDS,
          {
            name: "fundamento",
            type: "text",
            description: "",
            target: "all",
          },
        ],
      }),
    ];
    tableData.assignments = [
      assignment("concluido"),
      {
        ...assignment("pendente"),
        id: "a2",
        user_id: "rev2",
      },
    ];
    tableData.responses = [
      resp("a", "proc", { answers: { decisao: "proc", fundamento: "A" } }),
      resp("b", "improc", {
        answers: { decisao: "improc", fundamento: "B" },
      }),
    ];
    tableData.reviews = [
      {
        project_id: "p1",
        document_id: "doc1",
        reviewer_id: "rev1",
        field_name: "decisao",
        verdict: "proc",
        field_hash: null,
      },
    ];
    queryErrors["assignments:update"] = {
      message:
        'duplicate key value violates unique constraint "assignments_one_active_comparacao_per_doc"',
      code: "23505",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).resolves.toBeUndefined();

    expect(updateCallsOf("assignments")[0].payload).toEqual({
      status: "em_andamento",
      completed_at: null,
    });
    expect(warnSpy.mock.calls[0][0]).toContain(
      '"intendedStatus":"em_andamento"',
    );
  });

  it("propaga erro de UPDATE diferente de violação única", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.assignments = [assignment("concluido")];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    queryErrors["assignments:update"] = {
      message: "permission denied for table assignments",
      code: "42501",
    };
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).rejects.toThrow("permission denied for table assignments");
  });

  it("propaga 23505 de outra constraint mesmo na regressão de uma concluída", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.assignments = [assignment("concluido")];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    queryErrors["assignments:update"] = {
      message:
        'duplicate key value violates unique constraint "assignments_document_id_user_id_type_key"',
      code: "23505",
    };
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).rejects.toThrow("assignments_document_id_user_id_type_key");
  });

  it("não trata 23505 como skip fora da regressão de uma concluída", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.assignments = [assignment("pendente")];
    tableData.responses = [resp("a", "proc"), resp("b", "proc")];
    queryErrors["assignments:update"] = {
      message: "unexpected unique violation",
      code: "23505",
    };
    const client = makeClient();

    await expect(
      syncCompareAssignment(client as never, "p1", "doc1", "rev1"),
    ).rejects.toThrow("unexpected unique violation");
  });
});

