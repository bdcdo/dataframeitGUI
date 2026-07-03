// Funções puras da regeneração do backlog de auto-revisão. Extraídas de
// actions/field-reviews.ts: arquivos "use server" só podem exportar funções
// async (regra do Next), então o que é puro e testável vive aqui e a action
// importa.

import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { isCodingComplete } from "@/lib/coding-completeness";
import type { EquivalenceByDocField } from "@/lib/compare-queue";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

export interface HumanResponseRow {
  id: string;
  document_id: string;
  respondent_id: string;
  answers: Record<string, unknown>;
  answer_field_hashes: AnswerFieldHashes;
}

export interface LlmResponseRow {
  id: string;
  document_id: string;
  answers: Record<string, unknown>;
  answer_field_hashes: AnswerFieldHashes;
}

export interface ExistingFieldReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  self_verdict: string | null;
}

export interface AssignmentRow {
  project_id: string;
  document_id: string;
  user_id: string;
  type: "auto_revisao";
  status: "pendente";
}

export interface FieldReviewRow {
  project_id: string;
  document_id: string;
  field_name: string;
  human_response_id: string;
  llm_response_id: string;
  self_reviewer_id: string;
}

// Varre as respostas humanas completas e calcula quais divergem do LLM —
// puro, sem I/O (opera só sobre dados já pré-carregados por fetchBacklogInputs).
export function computeBacklogRows(
  projectId: string,
  humanResponses: HumanResponseRow[],
  llmByDocId: Map<string, LlmResponseRow>,
  equivByDoc: EquivalenceByDocField,
  fields: PydanticField[],
): { assignmentRows: AssignmentRow[]; fieldReviewRows: FieldReviewRow[]; regenerated: number } {
  const assignmentRows: AssignmentRow[] = [];
  const fieldReviewRows: FieldReviewRow[] = [];
  let regenerated = 0;

  for (const human of humanResponses) {
    const llm = llmByDocId.get(human.document_id);
    if (!llm) continue;

    // #174: só arbitrar codificações completas. is_partial é sinal inútil de
    // completude para o humano (quase sempre false), então o filtro de query
    // não basta: aqui pulamos respostas humanas cuja codificação não está
    // completa. Espelha o gate inline de saveResponse (allAnswered) via o
    // mesmo helper. Sem isto, codificações em andamento eram varridas para a
    // arbitragem e apareciam como "(vazio)" em diversos campos.
    //
    // Staleness-aware: passamos answer_field_hashes porque a avaliação é
    // RETROATIVA (schema atual vs. codificações antigas). Sem isto, um campo
    // obrigatório adicionado depois (ex.: `medicamento`) tornaria toda
    // codificação anterior "incompleta", varrendo arbitragens legítimas.
    if (!isCodingComplete(fields, human.answers ?? {}, human.answer_field_hashes)) {
      continue;
    }

    const divergent = computeDivergentFieldNames(
      fields,
      [
        {
          id: human.id,
          answers: human.answers ?? {},
          answerFieldHashes: human.answer_field_hashes,
        },
        {
          id: llm.id,
          answers: llm.answers ?? {},
          answerFieldHashes: llm.answer_field_hashes,
        },
      ],
      equivByDoc.get(human.document_id),
    );
    if (divergent.length === 0) continue;

    regenerated++;
    assignmentRows.push({
      project_id: projectId,
      document_id: human.document_id,
      user_id: human.respondent_id,
      type: "auto_revisao",
      status: "pendente",
    });
    for (const fieldName of divergent) {
      fieldReviewRows.push({
        project_id: projectId,
        document_id: human.document_id,
        field_name: fieldName,
        human_response_id: human.id,
        llm_response_id: llm.id,
        self_reviewer_id: human.respondent_id,
      });
    }
  }

  return { assignmentRows, fieldReviewRows, regenerated };
}

// Compartilhado entre diffReviewsToRemove e removeOrphanAssignments (na
// action): as duas reconciliam uma coleção recém-computada contra uma
// existente via chave composta document_id+algo. Puro.
export function compositeKeySet<T>(rows: T[], keyFn: (row: T) => string): Set<string> {
  return new Set(rows.map(keyFn));
}

// --- Reconcile: quais field_reviews não deveriam mais existir ---
// O conjunto correto é o que acabou de ser computado em fieldReviewRows.
// Linhas pendentes (self_verdict IS NULL) fora desse conjunto sao espurias
// — tipicamente campos que ficaram "stale" apos edicao de schema — e podem
// ser apagadas. Linhas ja resolvidas pelo pesquisador sao preservadas. Puro.
export function diffReviewsToRemove(
  existingReviews: ExistingFieldReviewRow[],
  fieldReviewRows: FieldReviewRow[],
): { idsToDelete: string[]; keptResolved: number } {
  const correctKeys = compositeKeySet(
    fieldReviewRows,
    (r) => `${r.document_id}|${r.field_name}`,
  );

  const idsToDelete: string[] = [];
  let keptResolved = 0;
  for (const fr of existingReviews) {
    if (correctKeys.has(`${fr.document_id}|${fr.field_name}`)) continue;
    if (fr.self_verdict == null) {
      idsToDelete.push(fr.id);
    } else {
      keptResolved++;
    }
  }
  return { idsToDelete, keptResolved };
}
