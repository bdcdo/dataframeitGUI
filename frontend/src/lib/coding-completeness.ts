import { isFieldVisible } from "@/lib/conditional";
import type { PydanticField } from "@/lib/types";

// Prefixo gravado quando o pesquisador escolhe a opção "Outro" mas ainda não
// digitou o complemento de texto livre. Um valor exatamente igual ao prefixo
// (sem complemento) conta como resposta incompleta. Mantido em sincronia com o
// gate inline de saveResponse (actions/responses.ts).
const OTHER_PREFIX = "Outro: ";

function isIncompleteOther(v: unknown): boolean {
  return typeof v === "string" && v === OTHER_PREFIX;
}

// Campos que o humano precisa responder para a codificação contar como
// completa: visíveis para humano (target != "llm_only"/"none"), obrigatórios
// (required !== false) e cuja condição de visibilidade está satisfeita pelas
// respostas atuais.
export function requiredHumanFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): PydanticField[] {
  return fields.filter(
    (f) =>
      (f.target || "all") !== "llm_only" &&
      f.target !== "none" &&
      f.required !== false &&
      isFieldVisible(f, answers),
  );
}

// True quando todos os campos obrigatórios e visíveis para o humano estão
// respondidos. Fonte única da regra de "codificação completa", espelhada pelo
// gate inline de saveResponse (promoção a "concluido") e pelo backlog de
// auto-revisão (regenerateAutoReviewBacklog). Ver issue #174: sem esse gate, o
// backlog varria codificações em andamento (parciais) para a arbitragem, onde
// apareciam como "(vazio)" em diversos campos. Puro/client-safe — usado tanto
// em server actions quanto em testes Vitest.
export function isCodingComplete(
  fields: PydanticField[],
  answers: Record<string, unknown>,
): boolean {
  const required = requiredHumanFields(fields, answers);
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
