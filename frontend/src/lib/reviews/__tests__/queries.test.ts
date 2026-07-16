import { describe, it, expect } from "vitest";
import {
  buildReviewLookupMaps,
  computeTruncation,
  REVIEW_BASE_DATA_LIMIT,
  resolveViewedRespondentId,
} from "@/lib/reviews/queries";
import type { PydanticField } from "@/lib/types";

describe("buildReviewLookupMaps", () => {
  it("indexa campos e usa título, ID externo e ID como fallback do documento", () => {
    const fields = [
      { name: "resultado", type: "text", options: null, description: "" },
    ] as PydanticField[];
    const documents = [
      { id: "d1", title: "Título", external_id: "ext-1" },
      { id: "d2", title: null, external_id: "ext-2" },
      { id: "d3", title: null, external_id: null },
    ];

    const { fieldMap, docMap } = buildReviewLookupMaps(fields, documents);

    expect(fieldMap.get("resultado")).toBe(fields[0]);
    expect([...docMap]).toEqual([
      ["d1", "Título"],
      ["d2", "ext-2"],
      ["d3", "d3"],
    ]);
  });
});

// Array esparso: `.length` e o teto sem alocar 50k elementos.
const atLimit = () => Array(REVIEW_BASE_DATA_LIMIT);
const belowLimit = () => Array(REVIEW_BASE_DATA_LIMIT - 1);

describe("computeTruncation — flags do TruncationBanner (issue #105)", () => {
  it("nenhuma tabela no teto → todas false", () => {
    expect(computeTruncation(belowLimit(), belowLimit(), belowLimit())).toEqual({
      responses: false,
      reviews: false,
      documents: false,
    });
  });

  it("marca apenas a tabela que atingiu o teto", () => {
    expect(computeTruncation(atLimit(), belowLimit(), belowLimit())).toEqual({
      responses: true,
      reviews: false,
      documents: false,
    });
    expect(computeTruncation(belowLimit(), atLimit(), belowLimit())).toEqual({
      responses: false,
      reviews: true,
      documents: false,
    });
    expect(computeTruncation(belowLimit(), belowLimit(), atLimit())).toEqual({
      responses: false,
      reviews: false,
      documents: true,
    });
  });

  it("todas no teto → todas true", () => {
    expect(computeTruncation(atLimit(), atLimit(), atLimit())).toEqual({
      responses: true,
      reviews: true,
      documents: true,
    });
  });

  it("query que falhou (null) nao conta como truncada", () => {
    expect(computeTruncation(null, null, null)).toEqual({
      responses: false,
      reviews: false,
      documents: false,
    });
  });

  it("array vazio nao conta como truncado", () => {
    expect(computeTruncation([], [], [])).toEqual({
      responses: false,
      reviews: false,
      documents: false,
    });
  });
});

// Invariante de segurança: em "Meu Gabarito", `viewAsUser` (ver o gabarito de
// outro respondente) só vale para coordenador/criador/master. A policy RLS
// "Members view responses" não filtra por respondent_id, então esta função é a
// única barreira — por isso `isCoordinator` aqui é fail-closed.
describe("resolveViewedRespondentId — viewAsUser só para coordenador/criador/master", () => {
  const ownMemberUserId = "canonical-member";
  const other = "user-other";

  it("não-coordenador vê o membro canônico, mesmo passando viewAsUser", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: false,
        viewAsUser: other,
      }),
    ).toBe(ownMemberUserId);
  });

  it("coordenador pode ver as respostas de outro via viewAsUser", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: true,
        viewAsUser: other,
      }),
    ).toBe(other);
  });

  it("sem viewAsUser, sempre o membro canônico (mesmo coordenador)", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: true,
        viewAsUser: undefined,
      }),
    ).toBe(ownMemberUserId);
  });

  it("viewAsUser vazio é tratado como ausente (não impersona)", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: true,
        viewAsUser: "",
      }),
    ).toBe(ownMemberUserId);
  });
});
