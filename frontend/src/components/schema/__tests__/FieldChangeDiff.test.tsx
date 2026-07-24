// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldChangeDiff } from "../FieldChangeDiff";
import { ORDER_LOG_FIELD_NAME, PROJECT_LOG_FIELD_NAME } from "@/lib/schema-utils";
import type { SchemaChangeEntry } from "@/lib/types";

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
