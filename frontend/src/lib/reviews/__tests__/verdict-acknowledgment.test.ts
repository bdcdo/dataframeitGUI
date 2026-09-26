import { describe, expect, it } from "vitest";
import { acknowledgmentIsCurrent } from "@/lib/reviews/verdict-acknowledgment";

// O reconhecimento guarda o veredito reconhecido (#758): a rearbitragem
// reaproveita o id da review, e sem isso o "Aceitar correção" de um veredito
// valia para o veredito seguinte.
describe("acknowledgmentIsCurrent", () => {
  it("vale enquanto o veredito atual é o reconhecido", () => {
    expect(acknowledgmentIsCurrent({ acknowledged_verdict: "Sim" }, "Sim")).toBe(true);
  });

  it.each([
    ["veredito rearbitrado", "Não"],
    // O texto é o do veredito, sem normalização: a mesma igualdade do gatilho.
    ["só a caixa mudou", "sim"],
    ["só o espaço mudou", "Sim "],
  ])("deixa de valer quando o veredito muda (%s)", (_label, verdict) => {
    expect(acknowledgmentIsCurrent({ acknowledged_verdict: "Sim" }, verdict)).toBe(false);
  });

  it("sem veredito reconhecido não vale (linha de antes da coluna)", () => {
    expect(acknowledgmentIsCurrent({ acknowledged_verdict: null }, "Sim")).toBe(false);
    expect(acknowledgmentIsCurrent({}, "Sim")).toBe(false);
  });
});
