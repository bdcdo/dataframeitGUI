import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { CURRENT_HASH } from "@/test-utils/comparison-fixtures";

// compare-sync.ts abre com `import "server-only"`, que LANÇA fora de um Server
// Component. Mocká-lo para no-op deixa o módulo importável no Vitest (node).
vi.mock("server-only", () => ({}));

let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;

const updateCallsOf = (table?: string) => callsOf(writeCalls, "update", table);

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls });
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
  tableData = {
    projects: [projectRow()],
    assignments: [assignment("pendente")],
    responses: [],
    reviews: [],
    response_equivalences: [],
  };
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
