import type { PydanticField } from "@/lib/types";

// Hash do schema corrente. scanComparisonBacklog/createAutoComparisonIfDiverges/
// syncCompareAssignment aplicam o piso vivo `latest_major` (#247): respostas de
// versão antiga (hash != atual, semver abaixo do piso) são descartadas da
// contagem de divergência. Fixtures default usam este hash com semver NULL
// para qualificar pelo caminho de fallback por hash em
// responseQualifiesForVersion.
export const CURRENT_HASH = "hash-atual";

const DEFAULT_FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "", required: true },
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

// Equivalência registrada pela revisora entre duas respostas de um campo. Os
// snapshots precisam casar com as respostas atuais, senão
// `filterCurrentEquivalencePairs` descarta o par; `superseded_at: null` casa
// com o filtro `.is("superseded_at", null)` das queries.
export function makeEquivalenceRow(
  fieldName: string,
  a: { id: string; answer: unknown },
  b: { id: string; answer: unknown },
) {
  return {
    id: `eq-${a.id}-${b.id}`,
    project_id: "p1",
    document_id: "doc1",
    field_name: fieldName,
    response_a_id: a.id,
    response_b_id: b.id,
    reviewer_id: "rev1",
    response_a_answer_snapshot: a.answer,
    response_b_answer_snapshot: b.answer,
    superseded_at: null,
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
    response_equivalences: [],
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
