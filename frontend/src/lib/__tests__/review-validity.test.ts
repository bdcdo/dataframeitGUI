import { describe, it, expect } from "vitest";
import {
  fieldReviewIsCurrent,
  pickCellReview,
  pickValidCellReviews,
  reviewIsValid,
  reviewValidity,
  verdictInDomain,
  type ValidatableReview,
} from "@/lib/review-validity";
import type { PydanticField } from "@/lib/types";

function field(overrides: Partial<PydanticField> = {}): PydanticField {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "q",
    type: "single",
    options: ["Sim", "Não "],
    description: "P",
    hash: "aaaaaaaaaaaa",
    ...overrides,
  };
}

const singleField = field();
const singleOther = field({ options: ["Sim", "Não"], allow_other: true });
const multiField = field({ name: "m", type: "multi", options: ["A", "B"], hash: "bbbbbbbbbbbb" });
const multiOther = field({ name: "m", type: "multi", options: ["A", "B"], allow_other: true, hash: "bbbbbbbbbbbb" });
const textField = field({ name: "t", type: "text", options: null, hash: "cccccccccccc" });
const dateField = field({ name: "d", type: "date", options: null, hash: "dddddddddddd" });
const legacyField = field({ name: "l", options: ["Sim"], hash: undefined });

// `copied`: veredito copiado de uma resposta (voto em card, com
// `chosen_response_id`), em oposição ao digitado pelo revisor.
function review(verdict: string, field_hash: string | null, field_name = "q", copied = true): ValidatableReview {
  return { field_name, verdict, field_hash, chosen_response_id: copied ? "r1" : null };
}

// A mesma matriz de `supabase/tests/reviews_field_hash.test.sql`, bloco (b):
// as duas cópias da regra precisam falhar juntas quando uma derivar.
const MATRIX: Array<[string, string, string | null, PydanticField | undefined, boolean, boolean]> = [
  ["pergunta idêntica", "Sim", "aaaaaaaaaaaa", singleField, true, true],
  ["texto com espaço e trim", "  Não", "aaaaaaaaaaaa", singleField, true, true],
  ["pergunta alterada", "Sim", "ffffffffffff", singleField, true, false],
  ["campo removido", "Sim", "aaaaaaaaaaaa", undefined, true, false],
  ["hash NULL no domínio", "Sim", null, singleField, true, true],
  ["hash NULL com single renomeado", "Talvez", null, singleField, true, false],
  ["copiado com hash igual e valor fora do domínio", "Talvez", "aaaaaaaaaaaa", singleField, true, false],
  ["single com allow_other", "Outro: quase", "aaaaaaaaaaaa", singleOther, true, true],
  ["ambiguo", "ambiguo", "aaaaaaaaaaaa", singleField, true, true],
  ["pular", "pular", null, singleField, true, true],
  ["ambiguo com pergunta alterada", "ambiguo", "ffffffffffff", singleField, true, false],
  ["veredito em branco", "", "aaaaaaaaaaaa", singleField, true, true],
  ["multi JSON nas opções", '{"A":true,"B":false}', "bbbbbbbbbbbb", multiField, true, true],
  ["multi com opção extinta", '{"A":true,"C":true}', null, multiField, true, false],
  ["multi com opção extinta desmarcada", '{"A":true,"C":false}', null, multiField, true, true],
  ["multi com allow_other", '{"A":true,"Outro: x":true}', "bbbbbbbbbbbb", multiOther, true, true],
  ["multi votado em card", "A, B", null, multiField, true, true],
  ["multi votado em card com opção extinta", "A, C", null, multiField, true, false],
  ["texto sempre no domínio", "qualquer coisa", "cccccccccccc", textField, true, true],
  ["data sempre no domínio", "01/02/2020", "dddddddddddd", dateField, true, true],
  ["campo sem hash e veredito com hash", "Sim", "aaaaaaaaaaaa", legacyField, true, false],
  ["campo sem hash e veredito sem hash", "Sim", null, legacyField, true, true],

  // Digitado: sem resposta escolhida. Com o hash igual, as opções são as de
  // quando foi digitado, e o texto livre vale; sem hash, nada prova isso.
  ["digitado com hash igual e fora das opções", "Não houve", "aaaaaaaaaaaa", singleField, false, true],
  ["digitado com hash NULL e fora das opções", "Não houve", null, singleField, false, false],
  ["digitado com hash diferente", "Não houve", "ffffffffffff", singleField, false, false],
  ["digitado com hash igual nas opções", "Sim", "aaaaaaaaaaaa", singleField, false, true],
];

describe("reviewIsValid (matriz compartilhada com o teste SQL)", () => {
  it.each(MATRIX)("%s", (_label, verdict, hash, f, copied, expected) => {
    expect(reviewIsValid(review(verdict, hash, f?.name ?? "q", copied), f)).toBe(expected);
  });
});

describe("reviewValidity: motivo", () => {
  it("campo que saiu do schema", () => {
    expect(reviewValidity(review("Sim", "aaaaaaaaaaaa"), undefined)).toEqual({ valid: false, reason: "campo_removido" });
  });

  it("pergunta alterada vem antes do domínio", () => {
    expect(reviewValidity(review("Talvez", "ffffffffffff"), singleField)).toEqual({
      valid: false,
      reason: "pergunta_alterada",
    });
  });

  it("veredito fora das opções atuais", () => {
    expect(reviewValidity(review("Talvez", null), singleField)).toEqual({ valid: false, reason: "fora_do_dominio" });
  });

  it("pergunta idêntica em rodada nova vale: a regra não olha rodada", () => {
    // A review não carrega rodada nenhuma para a regra ler; o que a torna
    // válida é só o hash e o domínio.
    expect(reviewValidity(review("Sim", "aaaaaaaaaaaa"), singleField)).toEqual({ valid: true });
  });
});

describe("verdictInDomain", () => {
  it("multi sem opções aceita qualquer seleção", () => {
    expect(verdictInDomain('{"Z":true}', field({ type: "multi", options: [] }))).toBe(true);
  });

  it("multi com JSON ilegível cai para a leitura em texto", () => {
    expect(verdictInDomain("{A", multiField)).toBe(false);
    expect(verdictInDomain("A", multiField)).toBe(true);
  });

  it("só o espaço comum é aparado, como o btrim da cópia SQL", () => {
    expect(verdictInDomain("Sim\t", singleField)).toBe(false);
    expect(verdictInDomain("A\t", multiField)).toBe(false);
    expect(verdictInDomain("A, B\t", multiField)).toBe(false);
  });
});

describe("pickCellReview", () => {
  it("mais recente por created_at", () => {
    const older = { id: "b", created_at: "2026-01-01T00:00:00Z" };
    const newer = { id: "a", created_at: "2026-02-01T00:00:00Z" };
    expect(pickCellReview([older, newer])).toBe(newer);
    expect(pickCellReview([newer, older])).toBe(newer);
  });

  it("empate de instante desempata pelo maior id, mesmo com serialização diferente", () => {
    const a = { id: "a", created_at: "2026-01-01T00:00:00Z" };
    const b = { id: "b", created_at: "2026-01-01T00:00:00.000+00:00" };
    expect(pickCellReview([a, b])).toBe(b);
    expect(pickCellReview([b, a])).toBe(b);
  });

  it("vazio devolve undefined", () => {
    expect(pickCellReview([])).toBeUndefined();
  });
});

describe("pickValidCellReviews", () => {
  const fields = new Map([[singleField.name, singleField]]);
  const base = { document_id: "d1", field_name: "q", chosen_response_id: "r1" };

  it("escolhe entre as válidas: a inválida mais recente não esconde a válida", () => {
    const valid = { ...base, id: "1", created_at: "2026-01-01T00:00:00Z", verdict: "Sim", field_hash: "aaaaaaaaaaaa" };
    const stale = { ...base, id: "2", created_at: "2026-03-01T00:00:00Z", verdict: "Sim", field_hash: "ffffffffffff" };
    expect(pickValidCellReviews([valid, stale], fields).get("d1:q")).toBe(valid);
  });

  it("célula só com reviews inválidas fica de fora", () => {
    const stale = { ...base, id: "2", created_at: "2026-03-01T00:00:00Z", verdict: "Sim", field_hash: "ffffffffffff" };
    const removed = { ...base, field_name: "sumiu", id: "3", created_at: "2026-03-01T00:00:00Z", verdict: "x", field_hash: null };
    expect(pickValidCellReviews([stale, removed], fields).size).toBe(0);
  });
});

// A matriz é a mesma de `field_review_question_current` no bloco (b) de
// `supabase/tests/judgments_follow_question.test.sql`.
describe("fieldReviewIsCurrent", () => {
  const current = { hash: "aaaaaaaaaaaa" };
  it.each([
    { label: "carimbo igual ao hash atual", fieldHash: "aaaaaaaaaaaa", current, expected: true },
    { label: "carimbo de outra versao da pergunta", fieldHash: "ffffffffffff", current, expected: false },
    { label: "campo removido ou renomeado", fieldHash: "aaaaaaaaaaaa", current: undefined, expected: false },
    { label: "carimbo NULL (legado)", fieldHash: null, current, expected: true },
    { label: "carimbo NULL e campo removido", fieldHash: null, current: undefined, expected: false },
    { label: "campo atual sem hash e ciclo carimbado", fieldHash: "aaaaaaaaaaaa", current: {}, expected: false },
    { label: "campo atual sem hash e ciclo sem carimbo", fieldHash: null, current: {}, expected: true },
  ])("$label", ({ fieldHash, current: field, expected }) => {
    expect(fieldReviewIsCurrent(fieldHash, field)).toBe(expected);
  });
});
