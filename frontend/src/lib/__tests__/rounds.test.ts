import { describe, it, expect } from "vitest";
import {
  classifyDocStatus,
  versionEquals,
  isCurrentFilter,
  getCurrentRoundDescriptor,
  resolveRoundFilter,
  roundLabel,
  type RoundContext,
  type ResponseRoundFields,
} from "@/lib/rounds";
import type { SchemaVersion } from "@/lib/compare-version";
import type { Round } from "@/lib/types";

const v = (major: number, minor: number, patch: number): SchemaVersion => ({
  major,
  minor,
  patch,
});

const round = (id: string, label: string, projectId = "p1"): Round => ({
  id,
  project_id: projectId,
  label,
  created_at: new Date().toISOString(),
});

const mapRounds = (rs: Round[]) => new Map(rs.map((r) => [r.id, r]));

describe("versionEquals", () => {
  it("compara versoes por igualdade estrutural", () => {
    expect(versionEquals(v(1, 0, 0), v(1, 0, 0))).toBe(true);
    expect(versionEquals(v(1, 0, 0), v(1, 0, 1))).toBe(false);
    expect(versionEquals(v(0, 1, 0), v(1, 0, 0))).toBe(false);
  });
});

describe("isCurrentFilter", () => {
  it("considera vazio/null/undefined/'current' como atual", () => {
    expect(isCurrentFilter(undefined)).toBe(true);
    expect(isCurrentFilter(null)).toBe(true);
    expect(isCurrentFilter("")).toBe(true);
    expect(isCurrentFilter("current")).toBe(true);
  });

  it("nao considera valores especificos como atual", () => {
    expect(isCurrentFilter("all")).toBe(false);
    expect(isCurrentFilter("1.2.3")).toBe(false);
    expect(isCurrentFilter("uuid-xyz")).toBe(false);
  });
});

describe("getCurrentRoundDescriptor", () => {
  it("schema_version usa o rótulo X.Y.Z de formatVersion", () => {
    const ctx: RoundContext = {
      strategy: "schema_version",
      currentRoundId: null,
      currentVersion: v(1, 2, 0),
      rounds: [],
    };
    expect(getCurrentRoundDescriptor(ctx, mapRounds([]))).toEqual({
      key: "1.2.0",
      label: "1.2.0",
    });
  });

  it("manual sem rodada atual retorna chave vazia", () => {
    const ctx: RoundContext = {
      strategy: "manual",
      currentRoundId: null,
      currentVersion: v(0, 1, 0),
      rounds: [],
    };
    expect(getCurrentRoundDescriptor(ctx, mapRounds([]))).toEqual({
      key: "",
      label: "Sem rodada atual",
    });
  });

  it("manual com rodada atual mas removida cai no fallback", () => {
    const ctx: RoundContext = {
      strategy: "manual",
      currentRoundId: "missing",
      currentVersion: v(0, 1, 0),
      rounds: [],
    };
    expect(getCurrentRoundDescriptor(ctx, mapRounds([]))).toEqual({
      key: "missing",
      label: "Sem rodada atual",
    });
  });

  it("manual com rodada atual conhecida usa o label", () => {
    const r = round("r1", "Piloto");
    const ctx: RoundContext = {
      strategy: "manual",
      currentRoundId: "r1",
      currentVersion: v(0, 1, 0),
      rounds: [r],
    };
    expect(getCurrentRoundDescriptor(ctx, mapRounds([r]))).toEqual({
      key: "r1",
      label: "Piloto",
    });
  });
});

describe("classifyDocStatus — schema_version", () => {
  const ctx: RoundContext = {
    strategy: "schema_version",
    currentRoundId: null,
    currentVersion: v(1, 0, 0),
    rounds: [],
  };

  it("sem resposta -> no_response", () => {
    expect(classifyDocStatus(ctx, null, mapRounds([]))).toEqual({
      kind: "no_response",
    });
  });

  it("resposta na versao atual -> current_done", () => {
    const r: ResponseRoundFields = {
      schema_version_major: 1,
      schema_version_minor: 0,
      schema_version_patch: 0,
    };
    expect(classifyDocStatus(ctx, r, mapRounds([]))).toEqual({
      kind: "current_done",
    });
  });

  it("resposta em versao anterior -> previous com label", () => {
    const r: ResponseRoundFields = {
      schema_version_major: 0,
      schema_version_minor: 1,
      schema_version_patch: 0,
    };
    expect(classifyDocStatus(ctx, r, mapRounds([]))).toEqual({
      kind: "previous",
      label: "0.1.0",
    });
  });

  it("resposta sem versao -> current_pending (legado)", () => {
    const r: ResponseRoundFields = {
      schema_version_major: null,
      schema_version_minor: null,
      schema_version_patch: null,
    };
    expect(classifyDocStatus(ctx, r, mapRounds([]))).toEqual({
      kind: "current_pending",
    });
  });

  it("resposta parcial em versao atual -> current_pending", () => {
    const r: ResponseRoundFields = {
      schema_version_major: 1,
      schema_version_minor: 0,
      schema_version_patch: 0,
      is_partial: true,
    };
    expect(classifyDocStatus(ctx, r, mapRounds([]))).toEqual({
      kind: "current_pending",
    });
  });
});

describe("classifyDocStatus — manual", () => {
  const piloto = round("rp", "Piloto");
  const r2 = round("r2", "Rodada 2");
  const ctx: RoundContext = {
    strategy: "manual",
    currentRoundId: "r2",
    currentVersion: v(1, 0, 0),
    rounds: [piloto, r2],
  };

  it("sem rodada atual definida tudo vira pendente", () => {
    const noCurrent: RoundContext = { ...ctx, currentRoundId: null };
    const r: ResponseRoundFields = { round_id: "rp" };
    expect(classifyDocStatus(noCurrent, r, mapRounds([piloto, r2]))).toEqual({
      kind: "current_pending",
    });
  });

  it("resposta na rodada atual -> current_done", () => {
    const r: ResponseRoundFields = { round_id: "r2" };
    expect(classifyDocStatus(ctx, r, mapRounds([piloto, r2]))).toEqual({
      kind: "current_done",
    });
  });

  it("resposta em rodada anterior -> previous com label", () => {
    const r: ResponseRoundFields = { round_id: "rp" };
    expect(classifyDocStatus(ctx, r, mapRounds([piloto, r2]))).toEqual({
      kind: "previous",
      label: "Piloto",
    });
  });

  it("resposta com round_id inexistente cai em 'Rodada removida'", () => {
    // Caso de borda; com FK ON DELETE SET NULL deveria virar null antes de
    // chegar aqui. Mantido como guardrail.
    const r: ResponseRoundFields = { round_id: "fantasma" };
    expect(classifyDocStatus(ctx, r, mapRounds([piloto, r2]))).toEqual({
      kind: "previous",
      label: "Rodada removida",
    });
  });

  it("resposta sem round_id (FK setou null apos delete) -> 'Sem rodada'", () => {
    const r: ResponseRoundFields = { round_id: null };
    expect(classifyDocStatus(ctx, r, mapRounds([piloto, r2]))).toEqual({
      kind: "previous",
      label: "Sem rodada",
    });
  });

  it("resposta parcial mesmo na rodada atual -> current_pending", () => {
    const r: ResponseRoundFields = { round_id: "r2", is_partial: true };
    expect(classifyDocStatus(ctx, r, mapRounds([piloto, r2]))).toEqual({
      kind: "current_pending",
    });
  });
});

describe("roundLabel", () => {
  const rounds = mapRounds([round("r1", "Piloto")]);

  it("devolve o rotulo da rodada conhecida", () => {
    expect(roundLabel("r1", rounds)).toBe("Piloto");
  });

  it("round_id sem rodada correspondente -> 'Rodada removida'", () => {
    expect(roundLabel("fantasma", rounds)).toBe("Rodada removida");
  });

  it("round_id nulo -> 'Sem rodada'", () => {
    expect(roundLabel(null, rounds)).toBe("Sem rodada");
  });
});

describe("resolveRoundFilter", () => {
  const piloto = round("rp", "Piloto");
  const r2 = round("r2", "Rodada 2");

  describe("schema_version", () => {
    const ctx: RoundContext = {
      strategy: "schema_version",
      currentRoundId: null,
      currentVersion: v(1, 0, 0),
      rounds: [],
    };

    it("undefined/null/'current' viram 'current'", () => {
      expect(resolveRoundFilter(undefined, ctx, "1.0.0", ["0.9.0"])).toBe("current");
      expect(resolveRoundFilter(null, ctx, "1.0.0", ["0.9.0"])).toBe("current");
      expect(resolveRoundFilter("current", ctx, "1.0.0", ["0.9.0"])).toBe("current");
    });

    it("'all' permanece 'all'", () => {
      expect(resolveRoundFilter("all", ctx, "1.0.0", ["0.9.0"])).toBe("all");
    });

    it("versao igual a current vira 'current'", () => {
      expect(resolveRoundFilter("1.0.0", ctx, "1.0.0", ["0.9.0"])).toBe("current");
    });

    it("versao em previousVersions e mantida", () => {
      expect(resolveRoundFilter("0.9.0", ctx, "1.0.0", ["0.9.0", "0.8.0"])).toBe(
        "0.9.0",
      );
    });

    it("versao desconhecida vira 'current' (URL stale apos troca)", () => {
      expect(resolveRoundFilter("99.0.0", ctx, "1.0.0", ["0.9.0"])).toBe("current");
    });
  });

  describe("manual", () => {
    const ctx: RoundContext = {
      strategy: "manual",
      currentRoundId: "r2",
      currentVersion: v(1, 0, 0),
      rounds: [piloto, r2],
    };

    it("id de rodada conhecida e mantido", () => {
      expect(resolveRoundFilter("rp", ctx, "r2", [])).toBe("rp");
    });

    it("id == currentRoundKey vira 'current'", () => {
      expect(resolveRoundFilter("r2", ctx, "r2", [])).toBe("current");
    });

    it("id desconhecido vira 'current'", () => {
      expect(resolveRoundFilter("fantasma", ctx, "r2", [])).toBe("current");
    });

    it("'all' permanece 'all'", () => {
      expect(resolveRoundFilter("all", ctx, "r2", [])).toBe("all");
    });
  });
});
