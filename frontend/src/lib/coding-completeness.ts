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
  const required = requiredHumanFields(fields, answers, answerFieldHashes);
  return required.every((f) => isFieldAnswered(f, answers[f.name]));
}
