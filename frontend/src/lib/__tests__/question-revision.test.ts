import { describe, expect, it } from "vitest";
import {
  applyInstructionChoices,
  fieldsWithInstructionOnlyChange,
} from "@/lib/question-revision";
import { fieldHashOf } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";
const ID_NOVO = "00000000-0000-4000-8000-00000000000c";

const saved: PydanticField[] = [
  {
    id: ID_A,
    name: "resultado",
    type: "single",
    options: ["Sim", "Não"],
    description: "Houve provimento?",
    help_text: "Considere o dispositivo.",
  },
  {
    id: ID_B,
    name: "nota",
    type: "text",
    options: null,
    description: "Observações",
    question_revision: 2,
  },
];

const withEdit = (id: string, patch: Partial<PydanticField>): PydanticField[] =>
  saved.map((field) => (field.id === id ? { ...field, ...patch } : field));

const names = (fields: PydanticField[]) => fields.map((field) => field.name);

describe("fieldsWithInstructionOnlyChange", () => {
  it("pergunta quando só a instrução mudou", () => {
    const draft = withEdit(ID_A, { help_text: "Considere a ementa." });
    expect(names(fieldsWithInstructionOnlyChange(saved, draft))).toEqual(["resultado"]);
  });

  it("pergunta também quando a instrução é criada ou apagada", () => {
    expect(
      names(fieldsWithInstructionOnlyChange(saved, withEdit(ID_B, { help_text: "Nova" }))),
    ).toEqual(["nota"]);
    expect(
      names(fieldsWithInstructionOnlyChange(saved, withEdit(ID_A, { help_text: undefined }))),
    ).toEqual(["resultado"]);
  });

  it("casa por id, e não por nome nem por posição", () => {
    // Campo removido e recriado com o mesmo nome é campo novo: não tem
    // julgamento a derrubar.
    const recriado = withEdit(ID_A, { id: ID_NOVO, help_text: "Outra" });
    expect(fieldsWithInstructionOnlyChange(saved, recriado)).toEqual([]);
    const reordenado = withEdit(ID_A, { help_text: "Outra" }).toReversed();
    expect(names(fieldsWithInstructionOnlyChange(saved, reordenado))).toEqual(["resultado"]);
  });

  it("não pergunta quando a instrução e uma opção mudaram, porque o hash já muda", () => {
    const draft = withEdit(ID_A, {
      help_text: "Considere a ementa.",
      options: ["Sim", "Não", "Em parte"],
    });
    expect(fieldHashOf(draft[0])).not.toBe(fieldHashOf(saved[0]));
    expect(fieldsWithInstructionOnlyChange(saved, draft)).toEqual([]);
  });

  it("não pergunta quando a instrução e a descrição mudaram", () => {
    const draft = withEdit(ID_A, { help_text: "Outra", description: "Houve provimento total?" });
    expect(fieldsWithInstructionOnlyChange(saved, draft)).toEqual([]);
  });

  it("não pergunta por campo novo", () => {
    const draft: PydanticField[] = [
      ...saved,
      { id: ID_NOVO, name: "novo", type: "text", options: null, description: "N", help_text: "I" },
    ];
    expect(fieldsWithInstructionOnlyChange(saved, draft)).toEqual([]);
  });

  it("não pergunta por campo sem mudança nem por mudança fora da instrução", () => {
    expect(fieldsWithInstructionOnlyChange(saved, saved)).toEqual([]);
    const draft = withEdit(ID_A, { target: "llm_only", justification_prompt: "Cite" });
    expect(fieldsWithInstructionOnlyChange(saved, draft)).toEqual([]);
  });

  it("não pergunta de novo quando o rascunho já traz a revisão", () => {
    const draft = withEdit(ID_A, { help_text: "Outra", question_revision: 1 });
    expect(fieldsWithInstructionOnlyChange(saved, draft)).toEqual([]);
  });
});

describe("applyInstructionChoices", () => {
  const draft = saved.map((field) => ({ ...field, help_text: "Nova instrução" }));

  it("\"Muda como responder\" sobe o contador a partir do valor salvo", () => {
    const revised = applyInstructionChoices(saved, draft, {
      [ID_A]: "changes_answering",
      [ID_B]: "changes_answering",
    });
    expect(revised.map((field) => field.question_revision)).toEqual([1, 3]);
    expect(fieldHashOf(revised[0])).not.toBe(fieldHashOf(saved[0]));
  });

  it("\"Só esclarece\" não mexe no campo", () => {
    const revised = applyInstructionChoices(saved, draft, {
      [ID_A]: "clarifies_only",
      [ID_B]: "changes_answering",
    });
    expect(revised[0]).toBe(draft[0]);
    expect(revised[1].question_revision).toBe(3);
  });

  it("sem nenhum \"Muda como responder\", devolve o próprio rascunho", () => {
    expect(applyInstructionChoices(saved, draft, { [ID_A]: "clarifies_only" })).toBe(draft);
    expect(applyInstructionChoices(saved, draft, {})).toBe(draft);
  });

  it("reaplicar sobre rascunho já revisado não soma duas revisões", () => {
    const once = applyInstructionChoices(saved, draft, { [ID_A]: "changes_answering" });
    const twice = applyInstructionChoices(saved, once, { [ID_A]: "changes_answering" });
    expect(twice[0].question_revision).toBe(1);
  });
});
