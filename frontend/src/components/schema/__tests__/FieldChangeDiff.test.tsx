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
