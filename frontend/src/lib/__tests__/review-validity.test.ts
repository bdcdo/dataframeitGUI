import { describe, it, expect } from "vitest";
import {
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

function review(verdict: string, field_hash: string | null, field_name = "q"): ValidatableReview {
  return { field_name, verdict, field_hash };
}

// A mesma matriz de `supabase/tests/reviews_field_hash.test.sql`, bloco (b):
// as duas cópias da regra precisam falhar juntas quando uma derivar.
const MATRIX: Array<[string, string, string | null, PydanticField | undefined, boolean]> = [
  ["pergunta idêntica", "Sim", "aaaaaaaaaaaa", singleField, true],
  ["texto com espaço e trim", "  Não", "aaaaaaaaaaaa", singleField, true],
  ["pergunta alterada", "Sim", "ffffffffffff", singleField, false],
  ["campo removido", "Sim", "aaaaaaaaaaaa", undefined, false],
  ["hash NULL no domínio", "Sim", null, singleField, true],
  ["hash NULL com single renomeado", "Talvez", null, singleField, false],
  ["hash igual e valor fora do domínio", "Talvez", "aaaaaaaaaaaa", singleField, false],
  ["single com allow_other", "Outro: quase", "aaaaaaaaaaaa", singleOther, true],
  ["ambiguo", "ambiguo", "aaaaaaaaaaaa", singleField, true],
  ["pular", "pular", null, singleField, true],
  ["ambiguo com pergunta alterada", "ambiguo", "ffffffffffff", singleField, false],
  ["veredito em branco", "", "aaaaaaaaaaaa", singleField, true],
  ["multi JSON nas opções", '{"A":true,"B":false}', "bbbbbbbbbbbb", multiField, true],
  ["multi com opção extinta", '{"A":true,"C":true}', null, multiField, false],
  ["multi com opção extinta desmarcada", '{"A":true,"C":false}', null, multiField, true],
  ["multi com allow_other", '{"A":true,"Outro: x":true}', "bbbbbbbbbbbb", multiOther, true],
  ["multi votado em card", "A, B", null, multiField, true],
  ["multi votado em card com opção extinta", "A, C", null, multiField, false],
  ["texto sempre no domínio", "qualquer coisa", "cccccccccccc", textField, true],
  ["data sempre no domínio", "01/02/2020", "dddddddddddd", dateField, true],
  ["campo sem hash e veredito com hash", "Sim", "aaaaaaaaaaaa", legacyField, false],
  ["campo sem hash e veredito sem hash", "Sim", null, legacyField, true],
];

describe("reviewIsValid (matriz compartilhada com o teste SQL)", () => {
  it.each(MATRIX)("%s", (_label, verdict, hash, f, expected) => {
    expect(reviewIsValid(review(verdict, hash, f?.name ?? "q"), f)).toBe(expected);
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
  const base = { document_id: "d1", field_name: "q" };

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
