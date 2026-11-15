import { describe, expect, it } from "vitest";
import { concludedCodingDraftViolations } from "@/lib/concluded-coding-draft";

const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T11:00:00.000Z";
const T2 = "2026-11-01T12:00:00.000Z";

function check(
  completedAt: string | null,
  response: { is_partial: boolean | null; updated_at: string } | null,
  active = true,
) {
  return concludedCodingDraftViolations({
    assignments: [{ id: "a1", document_id: "d1", user_id: "u1", completed_at: completedAt }],
    activeDocIds: new Set(active ? ["d1"] : []),
    humanLatest: response ? [{ document_id: "d1", respondent_id: "u1", ...response }] : [],
  });
}

describe("concludedCodingDraftViolations", () => {
  it("rascunho gravado antes da conclusão viola: a conclusão não veio de envio completo", () => {
    expect(check(T1, { is_partial: true, updated_at: T0 })).toHaveLength(1);
  });

  // O #538 copia `completed_at = updated_at` da response que promove; o guard
  // de is_partial o impede de promover rascunho, mas um canal que o fizesse
  // copiando o carimbo tem de seguir acusado.
  it("promoção que copia o carimbo do rascunho (completed_at = updated_at) viola", () => {
    expect(check(T1, { is_partial: true, updated_at: T1 })).toHaveLength(1);
  });

  // #608/#626/#894: depois de concluída, um envio incompleto (schema mudou
  // entre abrir e enviar) marca is_partial=true e mantém o assignment
  // concluído. A response foi gravada DEPOIS da conclusão.
  it("envio incompleto posterior à conclusão é legítimo", () => {
    expect(check(T1, { is_partial: true, updated_at: T2 })).toEqual([]);
  });

  it("sem completed_at não há prova de reenvio: segue violação", () => {
    expect(check(null, { is_partial: true, updated_at: T2 })).toHaveLength(1);
  });

  it("submetida, legada sem sinal, sem response ou doc excluído não violam", () => {
    expect(check(T1, { is_partial: false, updated_at: T0 })).toEqual([]);
    expect(check(T1, { is_partial: null, updated_at: T0 })).toEqual([]);
    expect(check(T1, null)).toEqual([]);
    expect(check(T1, { is_partial: true, updated_at: T0 }, false)).toEqual([]);
  });
});
