/**
 * Regra da invariante `divergencia-de-auto-revisao-tem-ciclo-ou-request`
 * (scripts/invariants/check-invariants.ts), separada da leitura do banco para
 * poder ser testada: o script faz os SELECTs e este módulo decide o que é
 * violação.
 *
 * É a inversa de `outbox-de-auto-revisao-drena` (#683). Aquela olha da fila
 * para o trabalho e pega "a fila não drena"; esta olha do trabalho para a fila
 * e pega trabalho que SUMIU: divergência humano×LLM sem ciclo operacional em
 * `field_reviews` e sem request pendente na outbox. Nesse estado
 * `final_answers` não acha ciclo (`fr.id IS NULL`) e exporta a resposta do LLM
 * como 'consenso', em silêncio.
 *
 * A divergência sai do replay do mesmo cálculo que o reconciliador
 * (`lib/auto-review-reconciler.ts`) faz por documento: `computeBacklogRows`
 * sobre as respostas humanas completas de membros e a geração LLM corrente,
 * com as equivalências de valor do projeto. Medir pelo resultado, e não pela
 * forma do produtor, é o que impede a invariante de degenerar se o produtor
 * mudar (como mudou no #670).
 *
 * Falsos positivos que a regra fecha, e onde:
 * - consenso legítimo e codificação incompleta: o replay não produz linha
 *   (`computeDivergentFieldNames`, `isCodingComplete` dentro dele);
 * - "=" declarado pelo revisor: as equivalências de valor entram no replay;
 * - um revisor por campo: a RPC só cria ciclo para o PRIMEIRO self_reviewer de
 *   cada (documento, campo), então a cobertura é por (documento, campo), e
 *   nunca por (documento, campo, humano) — que acusaria todo documento com
 *   dois codificadores;
 * - janela do dreno: documento com request pendente fica isento.
 */

import {
  computeBacklogRows,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import type { ValueEquivalencesByField } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";
import type { Violation } from "@/lib/unique-index-violations";

/** Metadados leves de uma resposta corrente e completa (fase 1). */
export interface CoverageResponseMeta {
  id: string;
  project_id: string;
  document_id: string;
  respondent_type: string;
  respondent_id: string | null;
}

/**
 * Fase 1: das respostas `is_latest` e `is_partial = false` dos projetos em
 * auto-revisão, as que entram no replay — a geração LLM e as humanas de
 * membros do projeto, em documento ativo que tenha as duas. O reconciliador
 * descarta a humana de quem não é membro (`eligibleHumanResponses`), então
 * ela também não gera divergência aqui. Só destas o script busca `answers`.
 */
export function autoReviewCoverageCandidates(
  responses: readonly CoverageResponseMeta[],
  activeDocIds: ReadonlySet<string>,
  membersOf: ReadonlyMap<string, ReadonlySet<string>>,
): CoverageResponseMeta[] {
  const byDoc = new Map<string, { llm?: CoverageResponseMeta; humans: CoverageResponseMeta[] }>();
  for (const r of responses) {
    if (!activeDocIds.has(r.document_id)) continue;
    const isLlm = r.respondent_type === "llm";
    const isMemberHuman =
      r.respondent_type === "humano" &&
      r.respondent_id !== null &&
      membersOf.get(r.project_id)?.has(r.respondent_id) === true;
    if (!isLlm && !isMemberHuman) continue;
    const entry = byDoc.get(r.document_id) ?? { humans: [] };
    if (isLlm) entry.llm = r;
    else entry.humans.push(r);
    byDoc.set(r.document_id, entry);
  }
  return [...byDoc.values()].flatMap(({ llm, humans }) =>
    llm && humans.length > 0 ? [llm, ...humans] : [],
  );
}

/** Chave da cobertura: um ciclo operacional por (documento, campo). */
export function coverageKey(documentId: string, fieldName: string): string {
  return `${documentId}|${fieldName}`;
}

export interface AutoReviewCoverageInput {
  projectId: string;
  fields: PydanticField[];
  /** Humanas candidatas do projeto (fase 2, com `answers`). */
  humans: HumanResponseRow[];
  /** Gerações LLM correntes do projeto, uma por documento. */
  llmByDocId: Map<string, LlmResponseRow>;
  equivalencesByField: ValueEquivalencesByField;
  /** `coverageKey` de cada `field_reviews` com `superseded_at IS NULL`. */
  openCycles: ReadonlySet<string>;
  /** Documentos com linha em `auto_review_reconciliation_requests`. */
  pendingDocIds: ReadonlySet<string>;
}

export function autoReviewCoverageViolations({
  projectId,
  fields,
  humans,
  llmByDocId,
  equivalencesByField,
  openCycles,
  pendingDocIds,
}: AutoReviewCoverageInput): Violation[] {
  const { fieldReviewRows } = computeBacklogRows(
    projectId,
    humans,
    llmByDocId,
    equivalencesByField,
    fields,
  );
  const uncovered = new Map<string, string[]>();
  for (const row of fieldReviewRows) {
    if (pendingDocIds.has(row.document_id)) continue;
    const key = coverageKey(row.document_id, row.field_name);
    if (openCycles.has(key)) continue;
    const reviewers = uncovered.get(key) ?? [];
    reviewers.push(row.self_reviewer_id);
    uncovered.set(key, reviewers);
  }
  return [...uncovered].map(([key, reviewers]) => {
    const [documentId, fieldName] = key.split("|");
    return {
      key,
      detail: `doc ${documentId}, campo ${fieldName} (projeto ${projectId}): diverge do LLM para ${reviewers.join(", ")} sem ciclo em field_reviews nem request pendente`,
    };
  });
}
