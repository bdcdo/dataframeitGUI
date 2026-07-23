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
// de pydantic-field, nunca de uma re-derivação local.
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

// Um campo conta como respondido quando tem valor e esse valor não é um
// "Outro:" pela metade nem uma seleção múltipla vazia. Exportado porque a UI de
// codificação marca pergunta a pergunta com a MESMA régua que decide completude
// — duas cópias da regra é o que deixava "o que o botão exige" divergir de "o
// que o servidor considera concluído" (#519).
export function isAnsweredValue(field: PydanticField, value: unknown): boolean {
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
// codificação consome esta primitiva em vez de reimplementar a regra: enquanto
// existiam duas cópias, "o que o botão exige" e "o que o servidor considera
// concluído" podiam divergir sem nenhum gate reclamar (ver #519).
export function missingRequiredHumanFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): PydanticField[] {
  return requiredHumanFields(fields, answers, answerFieldHashes).filter(
    (f) => !isAnsweredValue(f, answers[f.name]),
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
// `answerFieldHashes` (opcional): quando avaliado RETROATIVAMENTE (backlog,
// reconciliação da auto-revisão) contra o schema atual, passar o snapshot per-campo
// da resposta evita que um campo obrigatório recém-adicionado torne codificações
// antigas — completas à época — falsamente "incompletas". O gate inline de
// saveResponse roda em save-time (schema = schema da codificação), então não
// precisa passar e mantém o comportamento staleness-blind.
export function isCodingComplete(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): boolean {
  return missingRequiredHumanFields(fields, answers, answerFieldHashes).length === 0;
}
