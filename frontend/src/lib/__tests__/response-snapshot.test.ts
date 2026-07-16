import { describe, expect, it } from "vitest";
import {
  buildPersistedResponseSnapshot,
  sanitizeStoredAnswers,
} from "@/lib/response-snapshot";
import { OTHER_PREFIX } from "@/lib/other-option";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

const field = (input: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", options: null, description: input.name, ...input }) as PydanticField;

describe("sanitizeStoredAnswers", () => {
  it("mantém valores atuais e omite single ou multi sem nenhuma opção válida", () => {
    const fields = [
      field({ name: "single", type: "single", options: ["X", "Y"] }),
      field({ name: "multi", type: "multi", options: ["X", "Y"] }),
      field({ name: "vazio", type: "multi", options: ["X"] }),
    ];

    expect(
      sanitizeStoredAnswers(fields, {
        single: "X",
        multi: ["X", "Z"],
        vazio: ["Z"],
      }),
    ).toEqual({ single: "X", multi: ["X"] });
    expect(sanitizeStoredAnswers(fields, { single: "A" })).toEqual({});
  });

  it("preserva Outro permitido e filtra só opções comuns inválidas", () => {
    const fields = [
      field({ name: "single", type: "single", options: ["X"], allow_other: true }),
      field({ name: "multi", type: "multi", options: ["X"], allow_other: true }),
    ];

    expect(
      sanitizeStoredAnswers(fields, {
        single: `${OTHER_PREFIX}livre`,
        multi: ["X", "Z", `${OTHER_PREFIX}livre`],
      }),
    ).toEqual({
      single: `${OTHER_PREFIX}livre`,
      multi: ["X", `${OTHER_PREFIX}livre`],
    });
  });

  it("usa apenas propriedades próprias e não fabrica constructor", () => {
    const fields = [field({ name: "constructor", type: "single", options: ["X"] })];
    expect(sanitizeStoredAnswers(fields, {})).toEqual({});
  });

  it("omite campos sem widget humano e condicionais ocultas", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"] }),
      field({ name: "detalhe", condition: { field: "gatilho", equals: "sim" } }),
      field({ name: "llm", target: "llm_only" }),
      field({ name: "none", target: "none" }),
    ];

    expect(
      sanitizeStoredAnswers(fields, {
        gatilho: "nao",
        detalhe: "órfão",
        llm: "segredo",
        none: "ignorado",
      }),
    ).toEqual({ gatilho: "nao" });
  });

  it("normaliza resposta ausente para objeto vazio", () => {
    expect(sanitizeStoredAnswers([field({ name: "q" })], null)).toEqual({});
    expect(sanitizeStoredAnswers([field({ name: "q" })], undefined)).toEqual({});
  });

  it("sem schema preserva a resposta bruta", () => {
    const answers = { legado: "valor" };
    expect(sanitizeStoredAnswers([], answers)).toBe(answers);
  });
});

describe("buildPersistedResponseSnapshot", () => {
  it("preserva campos não revisados e atualiza somente mudanças explícitas", () => {
    const fields = [
      field({ name: "partial", type: "multi", options: ["X", "Y"], hash: "partial-new" }),
      field({
        name: "other",
        type: "multi",
        options: ["X"],
        allow_other: true,
        hash: "other-new",
      }),
      field({ name: "edited", hash: "edited-new" }),
      field({ name: "cleared", type: "multi", options: ["X"], hash: "cleared-new" }),
      field({ name: "stale", type: "single", options: ["X", "Y"], hash: "stale-new" }),
      field({
        name: "constructor",
        type: "single",
        options: ["X", "Y"],
        hash: "constructor-new",
      }),
      field({ name: "fresh", hash: "fresh-new" }),
    ];
    const storedAnswers = {
      partial: ["X", "Z"],
      other: ["X", `${OTHER_PREFIX}livre`],
      edited: "antigo",
      cleared: ["X"],
      stale: "A",
      constructor: "A",
      removed: "legado",
    };
    const storedHashes: AnswerFieldHashes = {
      partial: "partial-old",
      other: "other-old",
      edited: "edited-old",
      cleared: "cleared-old",
      stale: "stale-old",
      constructor: "constructor-old",
      removed: "removed-old",
    };
    const rawSubmittedAnswers = {
      partial: ["X"],
      other: ["X", `${OTHER_PREFIX}livre`],
      edited: "novo",
      cleared: [],
      fresh: "primeiro",
    };
    const originalInputs = structuredClone({ storedAnswers, storedHashes, rawSubmittedAnswers });

    const result = buildPersistedResponseSnapshot({
      fields,
      storedAnswers,
      storedHashes,
      rawSubmittedAnswers,
    });

    expect(result.persistedAnswers).toEqual({
      partial: ["X", "Z"],
      other: ["X", `${OTHER_PREFIX}livre`],
      edited: "novo",
      cleared: [],
      stale: "A",
      constructor: "A",
      removed: "legado",
      fresh: "primeiro",
    });
    expect(result.answerFieldHashes).toEqual({
      partial: "partial-old",
      other: "other-old",
      edited: "edited-new",
      cleared: "cleared-new",
      stale: "stale-old",
      constructor: "constructor-old",
      removed: "removed-old",
      fresh: "fresh-new",
    });
    expect(Object.hasOwn(result.persistedAnswers, "constructor")).toBe(true);
    expect({ storedAnswers, storedHashes, rawSubmittedAnswers }).toEqual(originalInputs);
  });

  it("remove filho quando o pesquisador muda deliberadamente o gatilho", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"], hash: "g-new" }),
      field({ name: "detalhe", hash: "d-new", condition: { field: "gatilho", equals: "sim" } }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      storedAnswers: { gatilho: "sim", detalhe: "texto" },
      storedHashes: { gatilho: "g-old", detalhe: "d-old" },
      rawSubmittedAnswers: { gatilho: "nao" },
    });

    expect(result.persistedAnswers).toEqual({ gatilho: "nao" });
    expect(result.answerFieldHashes).toEqual({ gatilho: "g-new", detalhe: "d-new" });
  });

  it("preserva pai e filho ocultados por uma mudança do schema", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["X"], hash: "g-new" }),
      field({ name: "detalhe", hash: "d-new", condition: { field: "gatilho", equals: "X" } }),
      field({ name: "outro", hash: "o-new" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      storedAnswers: { gatilho: "sim", detalhe: "texto" },
      storedHashes: { gatilho: "g-old", detalhe: "d-old" },
      rawSubmittedAnswers: { outro: "novo" },
    });

    expect(result.persistedAnswers).toEqual({
      gatilho: "sim",
      detalhe: "texto",
      outro: "novo",
    });
    expect(result.answerFieldHashes).toEqual({
      gatilho: "g-old",
      detalhe: "d-old",
      outro: "o-new",
    });
  });

  it.each<AnswerFieldHashes>([null, {}])(
    "representa proveniência legacy como null por campo (%j)",
    (storedHashes) => {
      const fields = [
        field({ name: "stale", type: "single", options: ["X"], hash: "stale-new" }),
        field({ name: "outro", hash: "outro-new" }),
      ];

      const result = buildPersistedResponseSnapshot({
        fields,
        storedAnswers: { stale: "A" },
        storedHashes,
        rawSubmittedAnswers: { outro: "novo" },
      });

      expect(result.persistedAnswers).toEqual({ stale: "A", outro: "novo" });
      expect(result.answerFieldHashes).toEqual({ stale: null, outro: "outro-new" });
    },
  );

  it("preserva o snapshot bruto quando não há controles no schema", () => {
    const result = buildPersistedResponseSnapshot({
      fields: [],
      storedAnswers: { legado: "valor" },
      storedHashes: { legado: "hash-antigo" },
      rawSubmittedAnswers: {},
    });

    expect(result.persistedAnswers).toEqual({ legado: "valor" });
    expect(result.answerFieldHashes).toEqual({ legado: "hash-antigo" });
  });
});
