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

export interface FieldReviewRow {
  project_id: string;
  document_id: string;
  field_name: string;
  human_response_id: string;
  llm_response_id: string;
  self_reviewer_id: string;
}

// Respostas de um membro removido permanecem como histórico, mas não podem
// recriar assignments que o trigger rejeitará por falta de membership.
export function filterCurrentMemberResponses(
  responses: HumanResponseRow[],
  memberIds: string[],
): HumanResponseRow[] {
  const currentMemberIds = new Set(memberIds);
  return responses.filter((response) => currentMemberIds.has(response.respondent_id));
}

// Varre as respostas humanas completas e calcula quais divergem do LLM —
// puro, sem I/O (opera só sobre dados já pré-carregados por fetchBacklogInputs).
export function computeBacklogRows(
  projectId: string,
  humanResponses: HumanResponseRow[],
  llmByDocId: Map<string, LlmResponseRow>,
  equivByDoc: EquivalenceByDocField,
  fields: PydanticField[],
): { fieldReviewRows: FieldReviewRow[]; regenerated: number } {
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

  return { fieldReviewRows, regenerated };
}
