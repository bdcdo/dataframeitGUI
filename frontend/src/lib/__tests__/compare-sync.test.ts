import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type QueryError,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { CURRENT_HASH } from "@/test-utils/comparison-fixtures";

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

const FIELDS: PydanticField[] = [
  {
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
  ...over,
});

const assignment = (status: string) => ({
  id: "a1",
  project_id: "p1",
  document_id: "doc1",
  user_id: "rev1",
  type: "comparacao",
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
    response_equivalences: [],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadLib() {
  return import("@/lib/compare-sync");
}

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

  it("divergência na major corrente, sem veredito → não fecha (em_andamento/pendente)", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    const client = makeClient();
    await syncCompareAssignment(client as never, "p1", "doc1", "rev1");
    // Diverge e ninguém revisou: status alvo = pendente; como o assignment já é
    // pendente, não há update.
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  it("divergência corrente resolvida pela revisora → fecha (concluido)", async () => {
    const { syncCompareAssignment } = await loadLib();
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.reviews = [
      { project_id: "p1", document_id: "doc1", reviewer_id: "rev1", field_name: "decisao" },
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

describe("syncCompareAssignmentsForDocument (#545)", () => {
  const TWO_FIELDS: PydanticField[] = [
    ...FIELDS,
    {
      name: "fundamento",
      type: "text",
      options: null,
      description: "",
      target: "all",
    },
  ];

  const comparacao = (over: Record<string, unknown>) => ({
    ...assignment("concluido"),
    ...over,
  });

  // Duas respostas que divergem NOS DOIS campos: quem tiver veredito em
  // 'decisao' regride para em_andamento, quem não tiver vai para pendente. É
  // o que dá payloads distinguíveis a cada revisor — o mock compartilhado
  // registra o payload do UPDATE, não o filtro que o selecionou.
  const divergeEmDoisCampos = () => {
    tableData.projects = [projectRow({ pydantic_fields: TWO_FIELDS })];
    tableData.responses = [
      resp("a", "proc", { answers: { decisao: "proc", fundamento: "A" } }),
      resp("b", "improc", { answers: { decisao: "improc", fundamento: "B" } }),
    ];
  };

  // TRIP-WIRE da ordem de reabertura. Só UMA comparação pode ficar ativa por
  // documento (assignments_one_active_comparacao_per_doc), então quem regride
  // primeiro ocupa a vaga: a rodada CORRENTE (concluída mais recente) precisa
  // vir antes da arquivada. Remover `sortByReopenPriority` faz a iteração
  // seguir a ordem do SELECT — aqui, deliberadamente a errada — e este teste
  // falha com "pendente" na primeira posição.
  it("reabre a rodada mais recente antes da arquivada", async () => {
    const { syncCompareAssignmentsForDocument } = await loadLib();
    divergeEmDoisCampos();
    tableData.assignments = [
      comparacao({
        id: "a-antigo",
        user_id: "rev-antigo",
        completed_at: "2026-01-01T00:00:00Z",
      }),
      comparacao({
        id: "a-atual",
        user_id: "rev-atual",
        completed_at: "2026-06-01T00:00:00Z",
      }),
    ];
    tableData.reviews = [
      {
        project_id: "p1",
        document_id: "doc1",
        reviewer_id: "rev-atual",
        field_name: "decisao",
      },
    ];
    const client = makeClient();

    await syncCompareAssignmentsForDocument(client as never, "p1", "doc1");

    expect(
      updateCallsOf("assignments").map((c) => c.payload),
    ).toEqual([
      { status: "em_andamento", completed_at: null }, // rev-atual
      { status: "pendente", completed_at: null }, // rev-antigo
    ]);
  });

  it("a comparação ATIVA vem antes de qualquer concluída, inclusive a mais recente", async () => {
    const { syncCompareAssignmentsForDocument } = await loadLib();
    divergeEmDoisCampos();
    tableData.assignments = [
      comparacao({
        id: "a-concluida",
        user_id: "rev-concluida",
        completed_at: "2026-06-01T00:00:00Z",
      }),
      // Ativa: sem completed_at e com status fora do predicado do índice.
      // `pendente` de propósito — "ativa" é qualquer status IS DISTINCT FROM
      // 'concluido', não só em_andamento.
      comparacao({
        id: "a-ativa",
        user_id: "rev-ativa",
        status: "pendente",
        completed_at: null,
      }),
    ];
    tableData.reviews = [
      {
        project_id: "p1",
        document_id: "doc1",
        reviewer_id: "rev-ativa",
        field_name: "decisao",
      },
    ];
    const client = makeClient();

    await syncCompareAssignmentsForDocument(client as never, "p1", "doc1");

    // A ativa vem primeiro mesmo estando por último no SELECT e sem
    // `completed_at` para ordená-la pelo critério de recência.
    expect(
      updateCallsOf("assignments").map((c) => c.payload),
    ).toEqual([
      { status: "em_andamento", completed_at: null }, // rev-ativa
      { status: "pendente", completed_at: null }, // rev-concluida
    ]);
  });

  it("dedup por user_id: a mesma revisora não é sincronizada duas vezes", async () => {
    const { syncCompareAssignmentsForDocument } = await loadLib();
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.assignments = [
      comparacao({ id: "a1", user_id: "rev1", completed_at: "2026-06-01T00:00:00Z" }),
      comparacao({ id: "a1-dup", user_id: "rev1", completed_at: "2026-06-02T00:00:00Z" }),
    ];
    const client = makeClient();

    await syncCompareAssignmentsForDocument(client as never, "p1", "doc1");

    expect(updateCallsOf("assignments")).toHaveLength(1);
  });

  // Best-effort por revisora: o sync roda pós-commit, então uma falha isolada
  // não pode abortar as demais nem propagar para a action (que já respondeu
  // sucesso ao client).
  it("falha de uma revisora é logada e não interrompe as outras", async () => {
    const { syncCompareAssignmentsForDocument } = await loadLib();
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    tableData.assignments = [
      comparacao({ id: "a1", user_id: "rev1", completed_at: "2026-06-02T00:00:00Z" }),
      comparacao({ id: "a2", user_id: "rev2", completed_at: "2026-06-01T00:00:00Z" }),
    ];
    queryErrors["assignments:update"] = {
      message: "permission denied for table assignments",
      code: "42501",
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeClient();

    await expect(
      syncCompareAssignmentsForDocument(client as never, "p1", "doc1"),
    ).resolves.toBeUndefined();

    // Duas tentativas: a falha da primeira não impediu a segunda.
    expect(updateCallsOf("assignments")).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining("[compare-sync] falha ao sincronizar o assignment de rev1"),
      expect.stringContaining("[compare-sync] falha ao sincronizar o assignment de rev2"),
    ]);
  });

  // A leitura da lista é pré-requisito, não parte best-effort: sem ela não há
  // o que sincronizar e engolir o erro esconderia um sync que nunca rodou.
  it("propaga erro da leitura dos assignments do documento", async () => {
    const { syncCompareAssignmentsForDocument } = await loadLib();
    queryErrors["assignments:select"] = {
      message: "permission denied for table assignments",
      code: "42501",
    };
    const client = makeClient();

    await expect(
      syncCompareAssignmentsForDocument(client as never, "p1", "doc1"),
    ).rejects.toThrow("permission denied for table assignments");
  });

  it("documento sem comparação atribuída → nenhum update", async () => {
    const { syncCompareAssignmentsForDocument } = await loadLib();
    tableData.assignments = [];
    tableData.responses = [resp("a", "proc"), resp("b", "improc")];
    const client = makeClient();

    await syncCompareAssignmentsForDocument(client as never, "p1", "doc1");

    expect(updateCallsOf("assignments")).toHaveLength(0);
  });
});
