import { describe, expect, it } from "vitest";
import { fieldHashesFromChangeLog, type FieldChangeLogRow } from "@/lib/field-hash-universe";
import { computeFieldHash } from "@/lib/schema-utils";
import {
  RESULTADO_INTERMEDIATE_HASH,
  resultadoProductionLog,
} from "@/lib/__tests__/field-hash-universe-fixture";

let seq = 0;
function row(
  field_name: string,
  before_value: Record<string, unknown>,
  after_value: Record<string, unknown>,
): FieldChangeLogRow {
  seq += 1;
  const n = String(seq).padStart(3, "0");
  return {
    id: `id-${n}`,
    field_name,
    before_value,
    after_value,
    created_at: `2026-09-01T00:00:${n.slice(1)}.000Z`,
  };
}

function snapshot(name: string, options: string[] | null, description = "Pergunta?") {
  return { name, type: "single", options, description, help_text: null, target: "all" };
}

const hashOf = (name: string, options: string[] | null, description = "Pergunta?", revision?: number) =>
  computeFieldHash(name, "single", options, description, revision);

describe("fieldHashesFromChangeLog", () => {
  it("snapshot seguido de parcial de opções gera o hash da versão intermediária", () => {
    const log = [
      row("q", {}, snapshot("q", ["A", "B"])),
      row("q", { options: ["A", "B"] }, { options: ["A", "B", "C"] }),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(
      new Set([hashOf("q", ["A", "B"]), hashOf("q", ["A", "B", "C"])]),
    );
  });

  it("parcial antes de qualquer snapshot não gera hash, porque os atributos que ela não traz são desconhecidos", () => {
    // A parcial traz `type`, `options` e `description`: com o nome da entrada
    // ela bastaria para um hash, e é exatamente esse hash que não pode entrar.
    const log = [
      row(
        "q",
        { type: "text", options: null, description: "Antiga?" },
        { type: "single", options: ["A"], description: "Nova?" },
      ),
      row("q", {}, snapshot("q", ["B"])),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(new Set([hashOf("q", ["B"])]));
  });

  it("várias parciais em sequência geram uma versão por parcial, cada uma sobre a anterior", () => {
    const log = [
      row("q", {}, snapshot("q", ["A"])),
      row("q", { options: ["A"] }, { options: ["A", "B"] }),
      row("q", { description: "Pergunta?" }, { description: "Pergunta reformulada?" }),
      row("q", { question_revision: null }, { question_revision: 1 }),
      row("q", { target: "all" }, { target: "human_only" }),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(
      new Set([
        hashOf("q", ["A"]),
        hashOf("q", ["A", "B"]),
        hashOf("q", ["A", "B"], "Pergunta reformulada?"),
        hashOf("q", ["A", "B"], "Pergunta reformulada?", 1),
      ]),
    );
  });

  it("entrada de outro campo não contamina a reconstrução", () => {
    // Os dois campos têm as mesmas opções e a mesma descrição, para que a
    // parcial de `a` também passasse na conferência se fosse aplicada sobre
    // `b`, o último campo visto.
    const log = [
      row("a", {}, snapshot("a", ["X"])),
      row("b", {}, snapshot("b", ["X"])),
      row("a", { options: ["X"] }, { options: ["X", "Z"] }),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(
      new Set([hashOf("a", ["X"]), hashOf("b", ["X"]), hashOf("a", ["X", "Z"])]),
    );
  });

  it("chave presente só no before sai da versão reconstruída", () => {
    // `diffFields` grava `after.options = undefined` quando as opções somem, e
    // o jsonb perde a chave: o `after` chega vazio.
    const log = [
      row("q", {}, snapshot("q", ["A", "B"])),
      row("q", { options: ["A", "B"] }, {}),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(
      new Set([hashOf("q", ["A", "B"]), hashOf("q", null)]),
    );
  });

  it("campo removido perde a base: parcial seguinte sem nova adição não gera hash", () => {
    const log = [
      row("q", {}, snapshot("q", ["A"])),
      row("q", snapshot("q", ["A"]), {}),
      row("q", { options: ["A"] }, { options: ["A", "B"] }),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(new Set([hashOf("q", ["A"])]));
  });

  it("parcial cujo before não bate com a base não gera hash, nem as parciais seguintes até o próximo snapshot", () => {
    const log = [
      row("q", {}, snapshot("q", ["A"])),
      // O log pulou a mudança de ["A"] para ["X"].
      row("q", { options: ["X"] }, { options: ["X", "Y"] }),
      row("q", { description: "Pergunta?" }, { description: "Outra?" }),
      row("q", snapshot("q", ["X", "Y"], "Outra?"), {}),
      row("q", {}, snapshot("q", ["C"])),
      row("q", { options: ["C"] }, { options: ["C", "D"] }),
    ];
    expect(fieldHashesFromChangeLog(log)).toEqual(
      new Set([
        hashOf("q", ["A"]),
        hashOf("q", ["X", "Y"], "Outra?"),
        hashOf("q", ["C"]),
        hashOf("q", ["C", "D"]),
      ]),
    );
  });

  it("aplica as entradas em ordem (created_at, id), qualquer que seja a ordem de leitura", () => {
    const log = [
      row("q", {}, snapshot("q", ["A"])),
      row("q", { options: ["A"] }, { options: ["A", "B"] }),
      row("q", { options: ["A", "B"] }, { options: ["A", "B", "C"] }),
    ];
    const expected = new Set([
      hashOf("q", ["A"]),
      hashOf("q", ["A", "B"]),
      hashOf("q", ["A", "B", "C"]),
    ]);
    expect(fieldHashesFromChangeLog([...log].reverse())).toEqual(expected);
  });

  it("caso real: reproduz o hash da versão de quatro opções de `resultado`", () => {
    const hashes = fieldHashesFromChangeLog(resultadoProductionLog);
    expect(hashes.has(RESULTADO_INTERMEDIATE_HASH)).toBe(true);
    // A outra versão é a de três opções, que é também o `hash` atual do campo
    // em `pydantic_fields`; nenhuma terceira versão é inventada.
    expect(hashes).toEqual(new Set(["96b1d1360f80", RESULTADO_INTERMEDIATE_HASH]));
  });
});
