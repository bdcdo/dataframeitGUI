import type { PydanticField } from "@/lib/types";

// Hash do schema corrente. scanComparisonBacklog/createAutoComparisonIfDiverges/
// syncCompareAssignment aplicam o piso vivo `latest_major` (#247): respostas de
// versão antiga (hash != atual, semver abaixo do piso) são descartadas da
// contagem de divergência. Fixtures default usam este hash com semver NULL
// para qualificar pelo caminho de fallback por hash em
// responseQualifiesForVersion.
export const CURRENT_HASH = "hash-atual";

const DEFAULT_FIELDS: PydanticField[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "q1",
    type: "text",
    options: null,
    description: "",
    required: true,
    hash: "q1-hash",
  },
];

export function makeProjectRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    pydantic_fields: DEFAULT_FIELDS,
    pydantic_hash: CURRENT_HASH,
    min_responses_for_comparison: 2,
    comparison_includes_llm: true,
    automation_mode: "compare_humans",
    schema_version_major: null,
    schema_version_minor: null,
    schema_version_patch: null,
    ...over,
  };
}

// Resposta humana qualificada na versão corrente (hash atual, semver NULL).
// `extra` sobrescreve qualquer campo — incluindo document_id/pydantic_hash/
// schema_version_* — para emular rodadas antigas ou docs alternativos.
export function makeHumanResponse(
  respondentId: string,
  q1: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `r-${respondentId}`,
    project_id: "p1",
    document_id: "doc1",
    respondent_id: respondentId,
    respondent_type: "humano",
    is_latest: true,
    is_partial: false,
    answers: { q1 },
    answer_field_hashes: null,
    pydantic_hash: CURRENT_HASH,
    schema_version_major: null,
    schema_version_minor: null,
    schema_version_patch: null,
    // Chaves do filtro de embed `documents!inner` (fora-de-escopo): o mock
    // filter-aware compara r["documents.excluded_at"] literalmente.
    "documents.excluded_at": null,
    "documents.exclusion_pending_at": null,
    ...extra,
  };
}

// Equivalência de VALOR registrada pela revisora num campo (`value_equivalences`).
// Vale no projeto inteiro, na versão da pergunta com `fieldHash`; o default
// casa com o hash do campo em `DEFAULT_FIELDS` (`<campo>-hash`), senão a
// leitura (`currentValueEquivalences`) a ignora. Os ids das respostas só
// compõem o id da linha, para os testes manterem os nomes de antes.
export function makeEquivalenceRow(
  fieldName: string,
  a: { id: string; answer: unknown },
  b: { id: string; answer: unknown },
  fieldHash = `${fieldName}-hash`,
) {
  return {
    id: `eq-${a.id}-${b.id}`,
    project_id: "p1",
    field_name: fieldName,
    field_hash: fieldHash,
    value_a: a.answer,
    value_b: b.answer,
    reviewer_id: "rev1",
    source: "comparacao",
    origin_document_id: "doc1",
  };
}

export function makeProjectMember(userId: string) {
  return { user_id: userId, project_id: "p1", can_compare: true };
}

function makeActiveComparisonDocument(id: string) {
  return {
    id,
    project_id: "p1",
    excluded_at: null,
    exclusion_pending_at: null,
  };
}

export function makeEmptyComparisonTableData(
  documentIds: readonly string[] = ["doc1"],
): Record<string, unknown[]> {
  return {
    projects: [makeProjectRow()],
    project_members: [],
    assignments: [],
    responses: [],
    value_equivalences: [],
    documents: documentIds.map(makeActiveComparisonDocument),
  };
}

export function makeIncompleteCoderComparisonScenario() {
  return {
    responses: [
      makeHumanResponse("userA", "A"),
      makeHumanResponse("userB", "B"),
      // Parcial pela régua de completude do envio: fica fora da contagem,
      // mas segue codificador do documento (fora do pool de revisores).
      { ...makeHumanResponse("userC", "C"), answers: {}, is_partial: true },
    ],
    members: [makeProjectMember("userC"), makeProjectMember("userD")],
    openAssignments: [
      {
        document_id: "doc2",
        user_id: "userD",
        project_id: "p1",
        type: "comparacao",
        status: "pendente",
      },
    ],
  };
}
