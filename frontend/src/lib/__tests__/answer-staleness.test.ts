import { describe, it, expect } from "vitest";
import {
  buildFieldHashMap,
  fieldExistedWhenCoded,
  isFieldStale,
  mergeFieldHashes,
} from "@/lib/answer-staleness";
import { computeFieldHash } from "@/lib/schema-utils";
import { mergeSubmittedAnswers } from "@/lib/answer-merge";
import type { PydanticField } from "@/lib/types";

const field = (f: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", ...f }) as PydanticField;

describe("buildFieldHashMap", () => {
  it("projeta name -> hash e omite campo sem hash", () => {
    expect(
      buildFieldHashMap([
        field({ name: "a", hash: "h1" }),
        field({ name: "sem_hash" }),
        field({ name: "b", hash: "h2" }),
      ]),
    ).toEqual({ a: "h1", b: "h2" });
  });

  it("schema sem hashes populados vira {} — o sentinela de legacy dos leitores", () => {
    expect(buildFieldHashMap([field({ name: "a" })])).toEqual({});
  });
});

describe("fieldExistedWhenCoded", () => {
  it("chave presente = campo existia; ausente = não existia", () => {
    expect(fieldExistedWhenCoded({ a: "h1" }, "a")).toBe(true);
    expect(fieldExistedWhenCoded({ a: "h1" }, "b")).toBe(false);
  });

  it("null/undefined/{} são legacy — assume que existia", () => {
    expect(fieldExistedWhenCoded(null, "b")).toBe(true);
    expect(fieldExistedWhenCoded(undefined, "b")).toBe(true);
    expect(fieldExistedWhenCoded({}, "b")).toBe(true);
  });
});

describe("isFieldStale", () => {
  const base = {
    pydanticHash: "p1",
    fieldName: "q",
    projectPydanticHash: "p1",
  };

  it("hash igual = atual; hash diferente = desatualizado", () => {
    expect(
      isFieldStale({
        ...base,
        answerFieldHashes: { q: "h1" },
        currentFieldHashes: { q: "h1" },
      }),
    ).toBe(false);
    expect(
      isFieldStale({
        ...base,
        answerFieldHashes: { q: "h_antigo" },
        currentFieldHashes: { q: "h_novo" },
      }),
    ).toBe(true);
  });

  it("qualquer um dos lados faltando = stale (não dá para provar que é o mesmo campo)", () => {
    expect(
      isFieldStale({ ...base, answerFieldHashes: {}, currentFieldHashes: { q: "h1" } }),
    ).toBe(true);
    expect(
      isFieldStale({ ...base, answerFieldHashes: { q: "h1" }, currentFieldHashes: {} }),
    ).toBe(true);
  });

  it("sem snapshot per-campo, cai no hash do schema inteiro", () => {
    expect(
      isFieldStale({
        ...base,
        answerFieldHashes: null,
        currentFieldHashes: {},
        pydanticHash: "p_antigo",
        projectPydanticHash: "p_novo",
      }),
    ).toBe(true);
    expect(
      isFieldStale({ ...base, answerFieldHashes: null, currentFieldHashes: {} }),
    ).toBe(false);
  });

  it("projeto sem pydantic_hash não marca stale — não há contra o que comparar", () => {
    expect(
      isFieldStale({
        ...base,
        answerFieldHashes: null,
        currentFieldHashes: {},
        pydanticHash: "p_antigo",
        projectPydanticHash: null,
      }),
    ).toBe(false);
  });
});

describe("mergeFieldHashes", () => {
  it("preserva o hash da época só nos campos herdados", () => {
    expect(
      mergeFieldHashes({ q_opt: "h_antigo", q_txt: "h_txt" }, { q_opt: "h_novo", q_txt: "h_txt" }, [
        "q_opt",
      ]),
    ).toEqual({ q_opt: "h_antigo", q_txt: "h_txt" });
  });

  it("campo novo (ausente do snapshot antigo) mantém o hash atual", () => {
    // Herdado mas sem hash na época: nada a preservar, o mapa atual prevalece.
    expect(mergeFieldHashes({ a: "h1" }, { a: "h1", novo: "h_novo" }, ["novo"])).toEqual({
      a: "h1",
      novo: "h_novo",
    });
  });

  it("sem nada herdado, é o snapshot do schema atual", () => {
    expect(mergeFieldHashes({ q: "h_antigo" }, { q: "h_novo" }, [])).toEqual({ q: "h_novo" });
  });

  it("legacy (null) não tem o que herdar — comportamento idêntico ao de antes", () => {
    expect(mergeFieldHashes(null, { q: "h_novo" }, ["q"])).toEqual({ q: "h_novo" });
  });

  it("não muta as entradas", () => {
    const stored = { q: "h_antigo" };
    const current = { q: "h_novo" };
    mergeFieldHashes(stored, current, ["q"]);
    expect(stored).toEqual({ q: "h_antigo" });
    expect(current).toEqual({ q: "h_novo" });
  });
});

// O cenário da #484 ponta-a-ponta sobre as primitivas puras, com hashes REAIS:
// mudar as opções muda o hash do campo, que é o que faz o sinal existir.
describe("opções mudaram → hash muda → stale dispara (#484)", () => {
  const OPTS_ANTIGAS = ["A", "B"];
  const OPTS_NOVAS = ["X", "Y"];
  const hashAntigo = computeFieldHash("q_opt", "single", OPTS_ANTIGAS, "d");
  const hashNovo = computeFieldHash("q_opt", "single", OPTS_NOVAS, "d");
  const hashTxt = computeFieldHash("q_txt", "text", null, "d");

  it("mudar as opções muda o hash do campo", () => {
    expect(hashAntigo).not.toBe(hashNovo);
  });

  it("o valor herdado é persistido E permanece marcado como desatualizado", () => {
    const storedAnswers = { q_opt: "A", q_txt: "antigo" };
    const storedHashes = { q_opt: hashAntigo, q_txt: hashTxt };
    // A leitura descartou q_opt (fora das opções atuais), então o submit não a
    // devolve; o pesquisador só mexeu em q_txt.
    const submitted = { q_txt: "novo" };

    const answersToPersist = mergeSubmittedAnswers(storedAnswers, submitted);
    const inherited = Object.keys(answersToPersist).filter((n) => !(n in submitted));
    const currentHashes = buildFieldHashMap([
      field({ name: "q_opt", type: "single", options: OPTS_NOVAS, hash: hashNovo }),
      field({ name: "q_txt", hash: hashTxt }),
    ]);
    const persistedHashes = mergeFieldHashes(storedHashes, currentHashes, inherited);

    expect(answersToPersist.q_opt).toBe("A");

    const staleInput = {
      answerFieldHashes: persistedHashes,
      pydanticHash: "p_novo",
      currentFieldHashes: currentHashes,
      projectPydanticHash: "p_novo",
    };
    // O valor herdado continua denunciado como desatualizado — é o que a
    // Comparação/reviews mostram como badge e o que a #216 usa para saber o
    // que ainda precisa ser perguntado ao pesquisador.
    expect(isFieldStale({ ...staleInput, fieldName: "q_opt" })).toBe(true);
    // ...e o campo que de fato trafegou pelo formulário atual não é stale.
    expect(isFieldStale({ ...staleInput, fieldName: "q_txt" })).toBe(false);
    // Ambos seguem existindo para a comparação (a chave não some).
    expect(fieldExistedWhenCoded(persistedHashes, "q_opt")).toBe(true);
  });

  it("sem o merge de hashes, o valor herdado passaria por resposta ao schema atual", () => {
    // Regressão que este módulo existe para impedir: carimbar tudo com o hash
    // de agora apaga o sinal exatamente no campo que o preservou.
    const currentHashes = { q_opt: hashNovo };
    expect(
      isFieldStale({
        answerFieldHashes: currentHashes,
        pydanticHash: "p_novo",
        fieldName: "q_opt",
        currentFieldHashes: currentHashes,
        projectPydanticHash: "p_novo",
      }),
    ).toBe(false);
  });
});
