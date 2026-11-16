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
 *
 * Dois estados que a regra ACUSA de propósito, porque também saem como
 * 'consenso' no export: projeto que passou a `auto_review_llm` com
 * codificações já feitas e sem "Regenerar backlog" (a troca de modo não
 * enfileira nada), e campo cujo primeiro self_reviewer saiu da divergência
 * depois de ter ciclo — a RPC não abre ciclo para o segundo codificador
 * enquanto o histórico tiver o primeiro.
 */

import {
  computeBacklogRows,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import type { ValueEquivalencesByField } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";

interface Violation {
  key: string;
  detail: string;
}

/** Metadados leves de uma resposta corrente e completa (fase 1). */
export interface CoverageResponseMeta {
  id: string;
  project_id: string;
  document_id: string;
  respondent_type: string;
  respondent_id: string | null;
}

/** Documento que entra no replay: a geração LLM e as humanas de membros. */
export interface CoverageCandidate {
  llm: CoverageResponseMeta;
  humans: (CoverageResponseMeta & { respondent_id: string })[];
}

/**
 * Fase 1: das respostas `is_latest` e `is_partial = false` dos projetos em
 * auto-revisão, os documentos ativos que têm geração LLM e ao menos uma humana
 * de membro do projeto. Espelha a elegibilidade do reconciliador
 * (`readReconciliationInputs` e `eligibleHumanResponses`, que descarta a humana
 * de quem não é membro) e precisa acompanhá-la se ela mudar. Só destas
 * respostas o script busca `answers`.
 */
export function autoReviewCoverageCandidates(
  responses: readonly CoverageResponseMeta[],
  activeDocIds: ReadonlySet<string>,
  membersOf: ReadonlyMap<string, ReadonlySet<string>>,
): CoverageCandidate[] {
  const byDoc = new Map<string, { llm?: CoverageResponseMeta; humans: CoverageCandidate["humans"] }>();
  const entryOf = (documentId: string) => {
    const entry = byDoc.get(documentId) ?? { humans: [] };
    byDoc.set(documentId, entry);
    return entry;
  };
  for (const r of responses) {
    if (!activeDocIds.has(r.document_id)) continue;
    const { respondent_id } = r;
    if (r.respondent_type === "llm") entryOf(r.document_id).llm = r;
    else if (r.respondent_type === "humano" && respondent_id !== null && membersOf.get(r.project_id)?.has(respondent_id)) {
      entryOf(r.document_id).humans.push({ ...r, respondent_id });
    }
  }
  return [...byDoc.values()].flatMap(({ llm, humans }) => (llm && humans.length > 0 ? [{ llm, humans }] : []));
}

/** Chave da cobertura: um ciclo operacional por (documento, campo). */
export function coverageKey(documentId: string, fieldName: string): string {
  return `${documentId}|${fieldName}`;
}

/** Divergência do replay num (documento, campo). */
export interface AutoReviewDivergence {
  projectId: string;
  documentId: string;
  fieldName: string;
  /** Geração LLM contra a qual o replay divergiu. */
  llmResponseId: string;
  /** Codificadores cuja resposta diverge, sem repetição. */
  reviewers: string[];
}

export interface AutoReviewReplayInput {
  projectId: string;
  fields: PydanticField[];
  /** Humanas candidatas do projeto (fase 2, com `answers`). */
  humans: HumanResponseRow[];
  /** Gerações LLM correntes do projeto, uma por documento. */
  llmByDocId: Map<string, LlmResponseRow>;
  equivalencesByField: ValueEquivalencesByField;
}

/**
 * O replay do reconciliador, agregado por (documento, campo): a RPC só cria
 * ciclo para o primeiro self_reviewer de cada par, então é por par que se
 * cobra a cobertura.
 */
export function autoReviewDivergences({
  projectId,
  fields,
  humans,
  llmByDocId,
  equivalencesByField,
}: AutoReviewReplayInput): AutoReviewDivergence[] {
  const { fieldReviewRows } = computeBacklogRows(projectId, humans, llmByDocId, equivalencesByField, fields);
  const byPair = new Map<string, AutoReviewDivergence>();
  for (const row of fieldReviewRows) {
    const key = coverageKey(row.document_id, row.field_name);
    const divergence = byPair.get(key) ?? {
      projectId,
      documentId: row.document_id,
      fieldName: row.field_name,
      llmResponseId: row.llm_response_id,
      reviewers: [],
    };
    if (!divergence.reviewers.includes(row.self_reviewer_id)) divergence.reviewers.push(row.self_reviewer_id);
    byPair.set(key, divergence);
  }
  return [...byPair.values()];
}

export interface AutoReviewCoverageInput {
  divergences: readonly AutoReviewDivergence[];
  /** `coverageKey` de cada `field_reviews` com `superseded_at IS NULL`. */
  openCycles: ReadonlySet<string>;
  /** `llm_response_id` da request pendente de cada documento que tem uma. */
  pendingLlmOf: ReadonlyMap<string, string>;
}

/**
 * Divergência descoberta: sem ciclo operacional no (documento, campo) e sem
 * request pendente para a geração do replay. A request precisa apontar para
 * essa geração, como em `is_auto_review_reconciliation_pending` (que é o que
 * `final_answers` consulta): uma request presa a outra geração o worker só
 * reconhece como obsoleta, sem criar ciclo, e não cobre nada.
 */
export function autoReviewCoverageViolations({
  divergences,
  openCycles,
  pendingLlmOf,
}: AutoReviewCoverageInput): Violation[] {
  return divergences
    .filter(
      (d) =>
        pendingLlmOf.get(d.documentId) !== d.llmResponseId &&
        !openCycles.has(coverageKey(d.documentId, d.fieldName)),
    )
    .map((d) => ({
      key: coverageKey(d.documentId, d.fieldName),
      detail: `doc ${d.documentId}, campo ${d.fieldName} (projeto ${d.projectId}): diverge do LLM para ${d.reviewers.join(", ")} sem ciclo em field_reviews nem request pendente`,
    }));
}
