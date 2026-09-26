import { fieldHashOf, helpTextChanged } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

// A escolha de quem edita quando só a instrução de um campo mudou. "Muda como
// responder" sobe `question_revision`, o que muda o hash do campo e derruba,
// pelo mecanismo que já existe para qualquer mudança de hash, vereditos, pares
// "=", auto-revisões e decisões do LLM Insights daquele campo. "Só esclarece"
// grava a instrução nova e não mexe em nada disso.
export type InstructionChangeChoice = "changes_answering" | "clarifies_only";

export type InstructionChangeChoices = Readonly<
  Record<string, InstructionChangeChoice>
>;

// Campos (casados por `id`, que sobrevive a rename) cuja instrução mudou em
// relação ao schema salvo e cujo hash não mudou por outro motivo. Os demais
// não precisam da pergunta: campo novo não tem julgamento a derrubar, e campo
// cujo nome, tipo, opções ou descrição também mudaram já troca de hash sozinho.
export function fieldsWithInstructionOnlyChange(
  savedFields: readonly PydanticField[],
  draftFields: readonly PydanticField[],
): PydanticField[] {
  const savedById = new Map(savedFields.map((field) => [field.id, field]));
  return draftFields.filter((field) => {
    const saved = savedById.get(field.id);
    if (!saved) return false;
    return helpTextChanged(saved, field) && fieldHashOf(saved) === fieldHashOf(field);
  });
}

// Aplica as escolhas ao rascunho. O contador parte do valor SALVO, e não do
// rascunho, para que reaplicar as escolhas a um rascunho que já as recebeu não
// some duas revisões. Sem nenhum "Muda como responder", devolve o próprio
// rascunho, e quem chama sabe por identidade que não há o que gravar nele.
export function applyInstructionChoices(
  savedFields: readonly PydanticField[],
  draftFields: PydanticField[],
  choices: InstructionChangeChoices,
): PydanticField[] {
  if (!Object.values(choices).includes("changes_answering")) return draftFields;
  const savedById = new Map(savedFields.map((field) => [field.id, field]));
  return draftFields.map((field) => {
    const saved = savedById.get(field.id);
    if (!saved || choices[field.id] !== "changes_answering") return field;
    return { ...field, question_revision: (saved.question_revision ?? 0) + 1 };
  });
}
