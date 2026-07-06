// Tipos "wire" compartilhados entre `ComparePage`, seus hooks e a view
// `CompareWorkspace`. Extraídos de `ComparePage` para evitar import circular de
// tipos quando os hooks foram destacados do container.

export interface EquivalencePairWire {
  id: string;
  response_a_id: string;
  response_b_id: string;
  reviewer_id: string | null;
}

export interface CompareResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  respondent_id: string | null;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  is_latest: boolean;
  pydantic_hash: string | null;
  answer_field_hashes: Record<string, string> | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  created_at: string;
}

export interface CompareDocument {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

export interface PendingVerdict {
  kind: "response" | "ambiguous" | "skip" | "custom";
  verdict: string;
  chosenResponseId?: string;
  label: string;
}

/** Forma de cada item em `fieldResponses` (derivado por `useCompareFieldData`). */
export interface FieldResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  respondent_id: string | null;
  answer: unknown;
  justification: string | undefined;
  is_latest: boolean;
  isFieldStale: boolean;
  schemaVersion: string | null;
}

/**
 * Identidade de respondente para dedup/contagem: `respondent_id` quando
 * existe, senão o id da própria resposta — fallback para dados legados que
 * não funde respostas anônimas distintas (o id é único por linha). É a MESMA
 * chave nos dois lados que precisam concordar: a contagem de humanos da fila
 * (gate `minHumans` em analyze/compare/page.tsx) e o aviso "não preencheu"
 * (UnansweredNotice).
 */
export function respondentKey(r: {
  id: string;
  respondent_id: string | null;
}): string {
  return r.respondent_id ?? r.id;
}
