import { isFieldVisible } from "@/lib/conditional";
import { isIncompleteOther } from "@/lib/other-option";
import { fieldExistedWhenCoded } from "@/lib/answer-staleness";
import { resolveRequired, resolveTarget } from "@/lib/pydantic-field";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Campos que o humano precisa responder para a codificação contar como
// completa: visíveis para humano, obrigatórios, com a condição de visibilidade
// satisfeita pelas respostas atuais e — quando `answerFieldHashes` é fornecido —
// que já existiam no schema contra o qual a resposta foi codificada
// (staleness-aware). Os defaults de `target` e `required` saem dos resolvedores
// de pydantic-field, nunca de uma re-derivação local. Exportado para que a régua
// de completude da UI (useQuestionValidation) derive a contagem e o bloqueio de
// submit desta MESMA fonte, em vez de reimplementar os filtros e divergir.
export function requiredHumanFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): PydanticField[] {
  return fields.filter(
    (f) =>
      resolveTarget(f.target) !== "llm_only" &&
      resolveTarget(f.target) !== "none" &&
      resolveRequired(f.required) &&
      isFieldVisible(f, answers) &&
      fieldExistedWhenCoded(answerFieldHashes, f.name),
  );
}

// Predicado por-campo: `true` quando o valor conta como resposta válida para
// fins de completude. Trata vazio (`undefined`/`null`/`""`), "Outro:" incompleto
// em `single` e `multi` vazio/com "Outro:" incompleto como NÃO respondido. Fonte
// única desse check — consumido por `isCodingComplete` (aqui) e pela régua da UI
// (useQuestionValidation), para que a UI não mantenha uma cópia que possa derivar.
export function isFieldAnswered(field: PydanticField, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (field.type === "single" && isIncompleteOther(value)) return false;
  if (field.type === "multi" && Array.isArray(value)) {
    if (value.length === 0) return false;
    if (value.some(isIncompleteOther)) return false;
  }
  return true;
}

// Campos obrigatórios que ainda faltam — a régua de completude na forma que a UI
// precisa (quantos e quais), com `isCodingComplete` derivado dela. A UI de
// codificação e o feedback de save consomem esta primitiva em vez de reimplementar
// a regra: uma cópia paralela é o que deixava "o que o botão exige" divergir de "o
// que o servidor considera concluído" sem nenhum gate reclamar (#519).
export function missingRequiredHumanFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): PydanticField[] {
  return requiredHumanFields(fields, answers, answerFieldHashes).filter(
    (f) => !isFieldAnswered(f, answers[f.name]),
  );
}

// True quando todos os campos obrigatórios e visíveis para o humano estão
// respondidos. Fonte única da regra de "codificação completa", espelhada pelo
// gate inline de saveResponse (promoção a "concluido") e pelo backlog de
// auto-revisão (regenerateAutoReviewBacklog). Ver issue #174: sem esse gate, o
// backlog varria codificações em andamento (parciais) para a arbitragem, onde
// apareciam como "(vazio)" em diversos campos. Puro/client-safe — usado tanto
// em server actions quanto em testes Vitest.
//
// `answerFieldHashes` (opcional): passar o snapshot per-campo da resposta torna a
// avaliação staleness-aware — um campo obrigatório recém-adicionado ao schema não
// rebaixa uma codificação que estava completa à época, porque o carimbo prova
// quais campos existiam (ver fieldExistedWhenCoded). Dois consumidores passam o
// snapshot:
//   • a avaliação RETROATIVA (backlog de auto-revisão, reconciliação) contra o
//     schema atual, que sem isso marcaria toda codificação anterior a um bump de
//     schema como falsamente incompleta;
//   • o gate de `is_partial` em saveResponse, que avalia contra o snapshot da
//     própria escrita (buildPersistedResponseSnapshot). Para uma codificação NOVA
//     esse snapshot estampa o schema inteiro como chaves, então aware ≡ blind e
//     nenhum obrigatório em branco é perdoado; a distinção só morde no auto-save de
//     uma resposta JÁ submetida sob schema que cresceu — exatamente o caso que não
//     deve rebaixar um doc concluído (#519/#520).
// Quem permanece staleness-BLIND de propósito é a promoção a `concluido` em
// syncCodingAssignmentStatus (coding-sync): lá é o guard de não-rebaixar um
// assignment já concluído que sustenta a invariante, não o carimbo per-campo.
export function isCodingComplete(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): boolean {
  return missingRequiredHumanFields(fields, answers, answerFieldHashes).length === 0;
}
