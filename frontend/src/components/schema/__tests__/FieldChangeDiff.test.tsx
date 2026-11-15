// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { FieldChangeDiff } from "../FieldChangeDiff";
import { ORDER_LOG_FIELD_NAME, PROJECT_LOG_FIELD_NAME } from "@/lib/schema-utils";
import type { SchemaChangeEntry } from "@/lib/types";
import { propertyLabel } from "@/lib/schema-change-format";
import { TYPE_LABELS } from "@/lib/field-labels";

function entry(over: Partial<SchemaChangeEntry>): SchemaChangeEntry {
  return {
    id: "e1",
    fieldName: "q1",
    changeSummary: "",
    beforeValue: {},
    afterValue: {},
    changedBy: "Coordenador",
    userId: "u1",
    createdAt: "2026-07-16T12:00:00.000Z",
    changeType: "minor",
    version: { major: 0, minor: 2, patch: 0 },
    ...over,
  };
}

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

// As entradas de escopo de projeto não descrevem campo nenhum: `diffPydanticField`
// não reconhece as chaves delas e devolve `[]`, e o corpo do diff não abria. A
// mudança existia no banco, era auditável, e a tela mostrava uma linha vazia.
describe("FieldChangeDiff — entradas de escopo de projeto", () => {
  it("mostra a sequência antes e depois numa reordenação", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          fieldName: ORDER_LOG_FIELD_NAME,
          changeSummary: "ordem dos campos alterada",
          beforeValue: { order: ["q1", "q2", "q3"] },
          afterValue: { order: ["q3", "q1", "q2"] },
        })}
      />,
    );

    expect(screen.getByText("ordem dos campos alterada")).toBeTruthy();
    // A sequência, não o conjunto: numa reordenação pura os dois lados têm
    // exatamente os mesmos nomes, e um diff por adicionados/removidos não teria
    // o que mostrar.
    expect(screen.getByText("q1 → q2 → q3")).toBeTruthy();
    expect(screen.getByText("q3 → q1 → q2")).toBeTruthy();
  });

  it("descreve a publicação de MAJOR pelo resumo da entrada", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          fieldName: PROJECT_LOG_FIELD_NAME,
          changeSummary: "Nova versão MAJOR publicada: 1.0.0",
          beforeValue: { major: 0, minor: 2, patch: 0 },
          afterValue: { major: 1, minor: 0, patch: 0 },
          changeType: "major",
        })}
      />,
    );

    expect(screen.getByText("Nova versão MAJOR publicada: 1.0.0")).toBeTruthy();
  });
});

// Mudar só a obrigatoriedade de um subcampo existente é a única alteração que o
// particionamento kept/removed/added do SubfieldsDiff não enxergava: os dois
// lados têm a mesma chave e o mesmo rótulo, então o badge saía idêntico ao de
// antes. A entrada era gravada, o versionamento bumpava minor, e o histórico
// não mostrava nada (issue #491, mesmo sintoma do `Boolean(null)` no `required`
// de campo).
describe("FieldChangeDiff — obrigatoriedade de subcampo", () => {
  const comSubcampos = (subfields: unknown) => ({
    name: "q1",
    type: "text",
    description: "Campo",
    subfields,
  });

  it("mostra a transição quando o subcampo vira obrigatório", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          changeSummary: "subcampos",
          beforeValue: comSubcampos([{ key: "cid", label: "CID" }]),
          afterValue: comSubcampos([
            { key: "cid", label: "CID", required: true },
          ]),
        })}
      />,
    );

    expect(screen.getByText(/CID: opcional/)).toBeTruthy();
    expect(screen.getByText(/obrigatório/)).toBeTruthy();
  });

  it("mostra a transição inversa quando deixa de ser obrigatório", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          changeSummary: "subcampos",
          beforeValue: comSubcampos([
            { key: "cid", label: "CID", required: true },
          ]),
          afterValue: comSubcampos([{ key: "cid", label: "CID" }]),
        })}
      />,
    );

    expect(screen.getByText(/CID: obrigatório/)).toBeTruthy();
  });

  // O par da invariante: promover o default a explícito NÃO é transição — sem
  // isso, o teste acima passaria mesmo com a normalização desligada.
  it("não trata `required` ausente e `false` como mudança", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          changeSummary: "descrição alterada",
          beforeValue: comSubcampos([{ key: "cid", label: "CID" }]),
          afterValue: comSubcampos([
            { key: "cid", label: "CID", required: false },
          ]),
        })}
      />,
    );

    expect(screen.queryByText(/CID: /)).toBeNull();
  });

  it("marca subcampo obrigatório com asterisco nos adicionados", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          changeSummary: "subcampos",
          beforeValue: comSubcampos([{ key: "cid", label: "CID" }]),
          afterValue: comSubcampos([
            { key: "cid", label: "CID" },
            { key: "doenca", label: "Doença", required: true },
          ]),
        })}
      />,
    );

    expect(screen.getByText(/\+ Doença \*/)).toBeTruthy();
  });
});

// Corpo de uma propriedade: o rótulo (caixa alta) e o par antes → depois.
// Linha do snapshot de campo adicionado ou removido, pelo rótulo do diff.
function rowText(property: Parameters<typeof propertyLabel>[0]) {
  return screen.getByText(`${propertyLabel(property)}:`).parentElement!.textContent;
}

function propertySection(property: Parameters<typeof propertyLabel>[0]): string {
  const label = screen
    .getAllByText(propertyLabel(property))
    .find((el) => el.className.includes("uppercase"));
  return label!.parentElement!.textContent!.slice(propertyLabel(property).length);
}

describe("FieldChangeDiff — propriedades de valor curto (pílulas)", () => {
  const base = { name: "q1", type: "single", description: "Campo", options: ["A", "B"] };

  it.each([
    ["type", { type: "single" }, { type: "multi" }, `${TYPE_LABELS.single}${TYPE_LABELS.multi}`],
    ["target", { target: "all" }, { target: "llm_only" }, "TodosSó LLM"],
    ["required", { required: false }, { required: true }, "NãoSim"],
    ["allow_other", { allow_other: true }, { allow_other: false }, "SimNão"],
    ["subfield_rule", { subfield_rule: "all" }, { subfield_rule: "at_least_one" }, "Todos obrigatóriosPelo menos um"],
  ] as const)("%s mostra antes → depois formatados", (property, before, after, text) => {
    render(
      <FieldChangeDiff
        entry={entry({ beforeValue: { ...base, ...before }, afterValue: { ...base, ...after } })}
      />,
    );
    expect(propertySection(property)).toBe(text);
  });

  it("texto curto (descrição) cai no diff em linha", () => {
    render(
      <FieldChangeDiff
        entry={entry({ beforeValue: base, afterValue: { ...base, description: "Novo" } })}
      />,
    );
    expect(propertySection("description")).toBe("Campo→Novo");
  });
});

describe("FieldChangeDiff — nome no cabeçalho", () => {
  it("renomeado mostra o nome antigo riscado e o novo", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          beforeValue: { name: "q1", type: "text", description: "Campo" },
          afterValue: { name: "q2", type: "text", description: "Campo" },
        })}
      />,
    );
    expect(screen.getByLabelText("Campo renomeado")).toBeTruthy();
    const old = screen
      .getAllByText("q1")
      .find((el) => el.className.includes("line-through"));
    expect(old).toBeTruthy();
    expect(old!.parentElement!.textContent).toBe("q1q2");
  });

  it("adicionado mostra o nome novo; removido, o antigo", () => {
    render(
      <FieldChangeDiff
        entry={entry({ fieldName: "x", beforeValue: {}, afterValue: { name: "novo", type: "text", description: "d" } })}
      />,
    );
    expect(screen.getByLabelText("Campo novo")).toBeTruthy();
    expect(screen.getAllByText("novo").length).toBeGreaterThan(0);
    cleanup();
    render(
      <FieldChangeDiff
        entry={entry({ fieldName: "x", beforeValue: { name: "velho", type: "text", description: "d" }, afterValue: {} })}
      />,
    );
    expect(screen.getByLabelText("Campo removido")).toBeTruthy();
    expect(screen.getAllByText("velho").length).toBeGreaterThan(0);
  });
});

// O snapshot de campo adicionado ou removido omitia `target` e `required`
// quando o payload não trazia a chave, que é justamente o default ("Todos",
// obrigatório). O mesmo campo aparecia com ou sem as linhas conforme o default
// estivesse explícito ou não.
describe("FieldChangeDiff — snapshot de campo adicionado ou removido", () => {

  it.each([
    ["sem `target` nem `required`", {}],
    ["com os defaults explícitos", { target: "all", required: true }],
  ])("campo %s mostra os defaults", (_, extra) => {
    render(
      <FieldChangeDiff
        entry={entry({ afterValue: { name: "q1", type: "text", description: "d", ...extra } })}
      />,
    );
    expect(rowText("target")).toBe("alvo:Todos");
    expect(rowText("required")).toBe("obrigatoriedade:Sim");
  });

  it("valores não-default continuam aparecendo", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          beforeValue: { name: "q1", type: "text", description: "d", target: "human_only", required: false },
        })}
      />,
    );
    expect(rowText("target")).toBe("alvo:Só humano");
    expect(rowText("required")).toBe("obrigatoriedade:Não");
    // O diff abaixo do snapshot não inventa o default do lado removido.
    expect(screen.queryByText("Todos")).toBeNull();
    expect(screen.queryByText("Sim")).toBeNull();
  });
});

// O snapshot de campo adicionado ou removido não listava `allow_other`,
// `subfield_rule` nem os subcampos — só o diff abaixo dele, e só quando não
// eram o default. E rotulava `required` como "obrigatório", enquanto o diff
// do mesmo campo dizia "obrigatoriedade".
describe("FieldChangeDiff — snapshot completo e com os rótulos do diff", () => {
  const noRow = (property: Parameters<typeof propertyLabel>[0]) =>
    expect(screen.queryByText(`${propertyLabel(property)}:`)).toBeNull();

  it("snapshot e diff chamam `required` pelo mesmo nome", () => {
    render(
      <FieldChangeDiff
        entry={entry({ beforeValue: { name: "q1", type: "text", description: "d", required: false } })}
      />,
    );
    expect(rowText("required")).toBe(`${propertyLabel("required")}:Não`);
    expect(propertySection("required")).toBe("Não—");
  });

  it.each([
    ["sem a chave", {}, "Não"],
    ["com o default explícito", { allow_other: false }, "Não"],
    ["ligado", { allow_other: true }, "Sim"],
  ])("campo de escolha %s mostra `allow_other`", (_, extra, value) => {
    render(
      <FieldChangeDiff
        entry={entry({ afterValue: { name: "q1", type: "single", description: "d", options: ["A"], ...extra } })}
      />,
    );
    expect(rowText("allow_other")).toBe(`${propertyLabel("allow_other")}:${value}`);
  });

  it("campo que não é de escolha, sem `allow_other` gravado, não ganha a linha", () => {
    render(<FieldChangeDiff entry={entry({ afterValue: { name: "q1", type: "text", description: "d" } })} />);
    noRow("allow_other");
    noRow("subfields");
    noRow("subfield_rule");
  });

  // O diff abaixo do snapshot não olha o tipo: um `allow_other: true` gravado
  // num campo de texto legado aparecia no diff e sumia do snapshot.
  it("`allow_other` ligado num campo que não é de escolha também aparece", () => {
    render(
      <FieldChangeDiff
        entry={entry({ beforeValue: { name: "q1", type: "text", description: "d", allow_other: true } })}
      />,
    );
    expect(rowText("allow_other")).toBe(`${propertyLabel("allow_other")}:Sim`);
  });

  // Mesmo formatador do diff: regra fora do enum vira "—", e não valor vazio.
  it("regra de subcampos desconhecida aparece como —", () => {
    render(
      <FieldChangeDiff
        entry={entry({
          beforeValue: {
            name: "q1",
            type: "text",
            description: "d",
            subfields: [{ key: "cid", label: "CID" }],
            subfield_rule: "legado",
          },
        })}
      />,
    );
    expect(rowText("subfield_rule")).toBe(`${propertyLabel("subfield_rule")}:—`);
  });

  it.each([
    ["sem `subfield_rule`", {}, "Todos obrigatórios"],
    ["com `at_least_one`", { subfield_rule: "at_least_one" }, "Pelo menos um"],
  ])("subcampos e regra aparecem %s", (_, extra, rule) => {
    render(
      <FieldChangeDiff
        entry={entry({
          beforeValue: {
            name: "q1",
            type: "text",
            description: "d",
            subfields: [
              { key: "cid", label: "CID", required: true },
              { key: "obs", label: "Obs" },
            ],
            ...extra,
          },
        })}
      />,
    );
    expect(rowText("subfields")).toBe(`${propertyLabel("subfields")}:CID *, Obs`);
    expect(rowText("subfield_rule")).toBe(`${propertyLabel("subfield_rule")}:${rule}`);
  });
});

// O rótulo da propriedade também aparece sem o valor: no selo da linha
// recolhida do histórico e na mensagem de conflito ("<rótulo> de "q1"").
// Como adjetivo, "obrigatório" ali afirmava que o campo ficou obrigatório
// quando a mudança foi a oposta.
describe("FieldChangeDiff — selo da linha recolhida", () => {
  it("nomeia a propriedade `required` sem afirmar o valor", () => {
    render(
      <FieldChangeDiff
        defaultExpanded={false}
        entry={entry({
          beforeValue: { name: "q1", type: "text", description: "d" },
          afterValue: { name: "q1", type: "text", description: "d", required: false },
        })}
      />,
    );
    expect(screen.getByText("obrigatoriedade")).toBeTruthy();
    expect(screen.queryByText("obrigatório")).toBeNull();
  });
});
