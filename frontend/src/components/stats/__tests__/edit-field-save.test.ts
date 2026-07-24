import { describe, expect, it, vi } from "vitest";
import {
  applyFormEdits,
  saveMergedEdit,
  type EditFieldFormValues,
  type SubmitOutcome,
} from "../edit-field-save";
import type { PydanticField, SchemaBaselineIdentity } from "@/lib/types";

const q1: PydanticField = {
  name: "q1",
  type: "single",
  options: ["Sim", "Não"],
  description: "Pergunta 1",
};
// Depende de uma opção de q1: é o campo que o strip precisa alcançar quando a
// opção que dispara a condição é removida no diálogo.
const q2: PydanticField = {
  name: "q2",
  type: "text",
  options: null,
  description: "Pergunta 2",
  condition: { field: "q1", equals: "Não" },
};

// Os valores que o form devolve quando nada foi tocado, para cada teste mudar
// só a propriedade que está em jogo.
function formOf(overrides: Partial<EditFieldFormValues> = {}): EditFieldFormValues {
  return {
    description: q1.description,
    helpText: "",
    options: q1.options ?? [],
    allowOther: false,
    subfields: undefined,
    subfieldRule: "all",
    condition: undefined,
    justificationPrompt: "",
    ...overrides,
  };
}

const BASELINE: SchemaBaselineIdentity = { revision: 3 };

describe("applyFormEdits", () => {
  it("aplica a edição sobre o base capturado e preserva os outros campos", () => {
    const fields = applyFormEdits([q1, q2], "q1", formOf({
      description: "Pergunta 1 revista",
      helpText: "  Instruções  ",
    }));

    expect(fields[0]).toMatchObject({
      name: "q1",
      description: "Pergunta 1 revista",
      help_text: "Instruções",
    });
    expect(fields[1]).toEqual(q2);
  });

  it("remover uma opção limpa as condições que dependiam dela", () => {
    const fields = applyFormEdits([q1, q2], "q1", formOf({ options: ["Sim"] }));

    expect(fields[0].options).toEqual(["Sim"]);
    expect(fields[1].condition).toBeUndefined();
  });

  it("subcampos presentes zeram as opções próprias do campo", () => {
    const fields = applyFormEdits([q1], "q1", formOf({
      subfields: [{ key: "s1", label: "Subcampo 1" }],
      subfieldRule: "at_least_one",
    }));

    expect(fields[0]).toMatchObject({
      options: null,
      subfields: [{ key: "s1", label: "Subcampo 1" }],
      subfield_rule: "at_least_one",
    });
  });

  // O EditFieldDialog não renderiza sem `baseField`, então isto é o contrato do
  // módulo puro para um chamador futuro: sem o campo, não há edição a aplicar.
  it("base sem o campo devolve os campos intactos", () => {
    expect(applyFormEdits([q2], "q1", formOf())).toEqual([q2]);
  });
});

describe("saveMergedEdit", () => {
  const localEdit = applyFormEdits([q1], "q1", formOf({ description: "Local" }));

  // Edição concorrente em OUTRA propriedade: o merge tem que carregá-la ao
  // payload em vez de reescrevê-la com o valor congelado na abertura.
  it("carrega a edição concorrente de outra propriedade ao payload", async () => {
    const submit = vi.fn<(f: PydanticField[], b: SchemaBaselineIdentity) => Promise<SubmitOutcome>>()
      .mockResolvedValue({ status: "saved" });

    const result = await saveMergedEdit(
      [q1],
      localEdit,
      [{ ...q1, help_text: "Ajuda remota" }],
      BASELINE,
      submit,
    );

    expect(result).toEqual({ status: "saved" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0][0]).toMatchObject({
      description: "Local",
      help_text: "Ajuda remota",
    });
    expect(submit.mock.calls[0][1]).toEqual(BASELINE);
  });

  it("colisão na mesma propriedade bloqueia sem chamar o submit", async () => {
    const submit = vi.fn<(f: PydanticField[], b: SchemaBaselineIdentity) => Promise<SubmitOutcome>>();

    const result = await saveMergedEdit(
      [q1],
      localEdit,
      [{ ...q1, description: "Remota" }],
      BASELINE,
      submit,
    );

    expect(result.status).toBe("blocked");
    expect(submit).not.toHaveBeenCalled();
  });

  it("conflito de CAS re-mescla sobre o snapshot devolvido e reenvia uma vez", async () => {
    const submit = vi.fn<(f: PydanticField[], b: SchemaBaselineIdentity) => Promise<SubmitOutcome>>()
      .mockResolvedValueOnce({
        status: "conflict",
        current: {
          fields: [{ ...q1, help_text: "Ajuda remota" }],
          version: "0.1.4",
          revision: 9,
        },
      })
      .mockResolvedValueOnce({ status: "saved" });

    const result = await saveMergedEdit([q1], localEdit, [q1], BASELINE, submit);

    expect(result).toEqual({ status: "saved" });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0][0]).toMatchObject({
      description: "Local",
      help_text: "Ajuda remota",
    });
    // A revisão do reenvio é a devolvida pelo servidor, não a que já falhou.
    expect(submit.mock.calls[1][1]).toEqual({ revision: 9 });
  });

  it("re-merge que colide bloqueia sem um segundo submit", async () => {
    const submit = vi.fn<(f: PydanticField[], b: SchemaBaselineIdentity) => Promise<SubmitOutcome>>()
      .mockResolvedValueOnce({
        status: "conflict",
        current: {
          fields: [{ ...q1, description: "Remota" }],
          version: "0.1.4",
          revision: 9,
        },
      });

    const result = await saveMergedEdit([q1], localEdit, [q1], BASELINE, submit);

    expect(result.status).toBe("blocked");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("segundo conflito consecutivo vira falha, não um terceiro reenvio", async () => {
    const conflict: SubmitOutcome = {
      status: "conflict",
      current: { fields: [q1], version: "0.1.4", revision: 9 },
    };
    const submit = vi.fn<(f: PydanticField[], b: SchemaBaselineIdentity) => Promise<SubmitOutcome>>()
      .mockResolvedValue(conflict);

    const result = await saveMergedEdit([q1], localEdit, [q1], BASELINE, submit);

    expect(result).toMatchObject({ status: "error" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("erro do save volta pelo mesmo canal do bloqueio", async () => {
    const submit = vi.fn<(f: PydanticField[], b: SchemaBaselineIdentity) => Promise<SubmitOutcome>>()
      .mockResolvedValue({ status: "error", message: "Falha remota" });

    const result = await saveMergedEdit([q1], localEdit, [q1], BASELINE, submit);

    expect(result).toEqual({ status: "error", message: "Falha remota" });
  });
});

// A mensagem de bloqueio é o que resta ao usuário quando o save para: precisa
// nomear a disputa nos três `kind` que o merge produz, e não o id opaco.
describe("saveMergedEdit — a mensagem nomeia a disputa", () => {
  async function blockedMessage(
    base: PydanticField[],
    local: PydanticField[],
    remote: PydanticField[],
  ): Promise<string> {
    const result = await saveMergedEdit(base, local, remote, BASELINE, async () => ({
      status: "saved",
    }));
    if (result.status !== "blocked") throw new Error(`esperava blocked, veio ${result.status}`);
    return result.message;
  }

  it("colisão de propriedade nomeia o rótulo pt-BR e o campo", async () => {
    const message = await blockedMessage(
      [q1],
      [{ ...q1, description: "Local" }],
      [{ ...q1, description: "Remota" }],
    );
    expect(message).toContain('descrição de "q1"');
  });

  it("edit-delete nomeia o campo", async () => {
    const message = await blockedMessage(
      [q1, q2],
      [q1, { ...q2, description: "Local" }],
      [q1],
    );
    expect(message).toContain('o campo "q2"');
  });

  it("ordem incompatível nomeia a ordem", async () => {
    const q3: PydanticField = { ...q2, name: "q3", condition: undefined };
    const message = await blockedMessage(
      [q1, q2, q3],
      [q2, q1, q3],
      [q1, q3, q2],
    );
    expect(message).toContain("a ordem dos campos");
  });
});
