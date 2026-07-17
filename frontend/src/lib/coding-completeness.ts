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
function requiredHumanFields(
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

// True quando todos os campos obrigatórios e visíveis para o humano estão
// respondidos. Fonte única da regra de "codificação completa", espelhada pelo
// gate inline de saveResponse (promoção a "concluido") e pelo backlog de
// auto-revisão (regenerateAutoReviewBacklog). Ver issue #174: sem esse gate, o
// backlog varria codificações em andamento (parciais) para a arbitragem, onde
// apareciam como "(vazio)" em diversos campos. Puro/client-safe — usado tanto
// em server actions quanto em testes Vitest.
//
// `answerFieldHashes` (opcional): quando avaliado RETROATIVAMENTE (backlog,
// createAutoReviewIfDiverges) contra o schema atual, passar o snapshot per-campo
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
  return required.every((f) => {
    const v = answers[f.name];
    if (v === undefined || v === null || v === "") return false;
    if (f.type === "single" && isIncompleteOther(v)) return false;
    if (f.type === "multi" && Array.isArray(v)) {
      if (v.length === 0) return false;
      if (v.some(isIncompleteOther)) return false;
    }
    return true;
  });
}
