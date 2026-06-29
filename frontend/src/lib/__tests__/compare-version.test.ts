import { describe, it, expect } from "vitest";
import {
  versionGte,
  parseVersionStr,
  formatVersion,
  latestMajorAnchor,
  resolveMinVersion,
  responseQualifiesForVersion,
  type SchemaVersion,
  type VersionedResponse,
} from "@/lib/compare-version";
import { DEFAULT_COMPARE_FILTERS } from "@/lib/compare-filters";
import {
  computeDivergentFieldNames,
  resolveCompareStatus,
} from "@/lib/compare-divergence";
import type { PydanticField } from "@/lib/types";

const v = (major: number, minor: number, patch: number): SchemaVersion => ({
  major,
  minor,
  patch,
});

function resp(overrides: Partial<VersionedResponse>): VersionedResponse {
  return {
    respondent_type: "llm",
    is_latest: true,
    pydantic_hash: "hash-atual",
    schema_version_major: 0,
    schema_version_minor: 20,
    schema_version_patch: 0,
    ...overrides,
  };
}

describe("parseVersionStr", () => {
  it("parseia X.Y.Z", () => {
    expect(parseVersionStr("0.20.3")).toEqual(v(0, 20, 3));
    expect(parseVersionStr("2.0.0")).toEqual(v(2, 0, 0));
  });
  it("retorna null para entrada inválida", () => {
    expect(parseVersionStr("latest_major")).toBeNull();
    expect(parseVersionStr("1.2")).toBeNull();
    expect(parseVersionStr("")).toBeNull();
  });
});

describe("formatVersion", () => {
  it("formata em X.Y.Z", () => {
    expect(formatVersion(v(0, 20, 0))).toBe("0.20.0");
  });
});

describe("versionGte", () => {
  it("compara em ordem major > minor > patch", () => {
    expect(versionGte(v(0, 20, 3), v(0, 20, 0))).toBe(true);
    expect(versionGte(v(0, 20, 0), v(0, 20, 0))).toBe(true);
    expect(versionGte(v(0, 19, 9), v(0, 20, 0))).toBe(false);
    expect(versionGte(v(1, 0, 0), v(0, 99, 99))).toBe(true);
  });
});

describe("latestMajorAnchor", () => {
  // Núcleo da correção B2: em projetos major 0 o piso é o MINOR corrente,
  // não {0,0,0} (que aceitaria todas as minors e não separaria rodada nenhuma).
  it("ancora no minor corrente quando major é 0", () => {
    expect(latestMajorAnchor(v(0, 20, 0))).toEqual(v(0, 20, 0));
    expect(latestMajorAnchor(v(0, 20, 3))).toEqual(v(0, 20, 0));
    expect(latestMajorAnchor(v(0, 1, 5))).toEqual(v(0, 1, 0));
  });
  it("ancora no major corrente quando major >= 1", () => {
    expect(latestMajorAnchor(v(2, 5, 1))).toEqual(v(2, 0, 0));
    expect(latestMajorAnchor(v(1, 0, 0))).toEqual(v(1, 0, 0));
  });
});

describe("resolveMinVersion", () => {
  it("retorna null para 'all'", () => {
    expect(resolveMinVersion("all", v(0, 20, 0))).toBeNull();
  });
  it("regressão B2: latest_major em projeto 0.20.0 não vira {0,0,0}", () => {
    expect(resolveMinVersion("latest_major", v(0, 20, 0))).toEqual(v(0, 20, 0));
  });
  it("latest_major em projeto major >= 1 zera minor/patch", () => {
    expect(resolveMinVersion("latest_major", v(1, 2, 3))).toEqual(v(1, 0, 0));
  });
  it("parseia versão específica", () => {
    expect(resolveMinVersion("0.13.0", v(0, 20, 0))).toEqual(v(0, 13, 0));
  });
});

describe("responseQualifiesForVersion", () => {
  const floor = v(0, 20, 0); // piso latest_major de um projeto 0.20.0
  const proj = { pydanticHash: "hash-atual", version: v(0, 20, 0) };

  it("descarta resposta LLM superseded (is_latest=false)", () => {
    expect(
      responseQualifiesForVersion(resp({ is_latest: false }), floor, proj),
    ).toBe(false);
  });
  it("descarta resposta humana superseded (is_latest=false) — fix PR #213", () => {
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_latest: false }),
        floor,
        proj,
      ),
    ).toBe(false);
  });
  it("descarta superseded humana mesmo sem filtro de versão (minVersion null)", () => {
    expect(
      responseQualifiesForVersion(
        resp({ respondent_type: "humano", is_latest: false }),
        null,
        proj,
      ),
    ).toBe(false);
  });
  it("com filtro ativo, descarta resposta pré-versionamento (pydantic_hash NULL)", () => {
    expect(
      responseQualifiesForVersion(resp({ pydantic_hash: null }), floor, proj),
    ).toBe(false);
  });
  it("sem filtro (minVersion null), pré-versionamento passa", () => {
    expect(
      responseQualifiesForVersion(resp({ pydantic_hash: null }), null, proj),
    ).toBe(true);
  });
  it("regressão B3: resposta humana de minor antiga (0.19.x) reprovada sob piso 0.20.0", () => {
    const old = resp({
      respondent_type: "humano",
      schema_version_minor: 19,
      schema_version_patch: 5,
    });
    expect(responseQualifiesForVersion(old, floor, proj)).toBe(false);
  });
  it("resposta da minor corrente (0.20.x) qualifica via semver", () => {
    expect(
      responseQualifiesForVersion(resp({ schema_version_patch: 2 }), floor, proj),
    ).toBe(true);
  });

  // Fallback por hash (cláusula 5): respostas LLM legadas têm schema_version
  // NULL. Sem o fallback, B2 esvaziaria a comparação dessas respostas.
  const nullVer = (hash: string | null) =>
    resp({
      schema_version_major: null,
      schema_version_minor: null,
      schema_version_patch: null,
      pydantic_hash: hash,
    });
  it("schema_version NULL + hash atual qualifica (proxy de versão corrente)", () => {
    expect(responseQualifiesForVersion(nullVer("hash-atual"), floor, proj)).toBe(
      true,
    );
  });
  it("schema_version NULL + hash antigo reprova (schema anterior)", () => {
    expect(responseQualifiesForVersion(nullVer("hash-antigo"), floor, proj)).toBe(
      false,
    );
  });
});

// O fecho do parecer (compare-sync.ts) deriva seu piso de versão do MESMO
// default da UI que compare/page.tsx usa, via
// resolveMinVersion(DEFAULT_COMPARE_FILTERS.version, ...). Estes testes travam
// esse contrato e reproduzem o incidente #217/#218 no pipeline puro do sync,
// sem Supabase.
describe("fecho espelha o filtro default da UI (#217/#218)", () => {
  it("resolveMinVersion com o default da UI não impõe piso (default = 'all')", () => {
    // Se alguém mudar DEFAULT_COMPARE_FILTERS.version sem revisar o sync, este
    // teste quebra — a intenção é manter sync e visão default acoplados.
    expect(DEFAULT_COMPARE_FILTERS.version).toBe("all");
    expect(
      resolveMinVersion(DEFAULT_COMPARE_FILTERS.version, v(0, 20, 0)),
    ).toBeNull();
  });

  // Incidente Zolgensma: doc com várias codificações humanas — uma SUPERSEDED
  // (is_latest=false), uma pré-versionamento (pydantic_hash NULL), uma de minor
  // antiga (0.18.0) e duas da corrente (0.20.0). O sync antigo
  // (`is_latest || respondent_type === "humano"`) contava a superseded, que a
  // tela não mostra, criando divergência invisível → trava. Sob o default 'all'
  // (minVersion null), o fecho descarta SÓ a superseded e mantém o resto,
  // espelhando o que a revisora vê "sem filtro".
  type Row = VersionedResponse & {
    id: string;
    answers: Record<string, unknown>;
  };
  const proj = { pydanticHash: "hash-atual", version: v(0, 20, 0) };
  const minVersion = resolveMinVersion(
    DEFAULT_COMPARE_FILTERS.version,
    v(0, 20, 0),
  );

  const human = (
    id: string,
    answers: Record<string, unknown>,
    over: Partial<VersionedResponse>,
  ): Row => ({
    id,
    answers,
    respondent_type: "humano",
    is_latest: true,
    pydantic_hash: "hash-atual",
    schema_version_major: 0,
    schema_version_minor: 20,
    schema_version_patch: 0,
    ...over,
  });

  // "decisao" diverge entre os ativos (improc vs proc); "obs" só diverge se a
  // superseded entrar (ativos concordam em "irrelevante").
  const rows: Row[] = [
    human(
      "sup",
      { decisao: "improc", obs: "diferente" },
      { is_latest: false, pydantic_hash: "hash-antigo", schema_version_minor: 18 },
    ),
    human(
      "pre",
      { decisao: "improc", obs: "irrelevante" },
      {
        pydantic_hash: null,
        schema_version_major: null,
        schema_version_minor: null,
        schema_version_patch: null,
      },
    ),
    human(
      "v18",
      { decisao: "proc", obs: "irrelevante" },
      { pydantic_hash: "hash-018", schema_version_minor: 18 },
    ),
    human("v20a", { decisao: "proc", obs: "irrelevante" }, {}),
    human("v20b", { decisao: "proc", obs: "irrelevante" }, {}),
  ];

  const fields: PydanticField[] = [
    {
      name: "decisao",
      type: "single",
      options: ["proc", "improc"],
      description: "",
      target: "all",
    },
    { name: "obs", type: "text", options: null, description: "", target: "all" },
  ];

  const active = rows.filter((r) =>
    responseQualifiesForVersion(r, minVersion, proj),
  );

  it("o fecho descarta só a superseded, mantendo pré-versionamento e minor antiga", () => {
    expect(active.map((r) => r.id)).toEqual(["pre", "v18", "v20a", "v20b"]);
  });

  it("incluir a superseded (bug antigo) inflaria 'obs' como divergência invisível", () => {
    const withSuperseded = computeDivergentFieldNames(fields, rows);
    expect(withSuperseded).toContain("obs");
  });

  it("sem a superseded, 'obs' não diverge — só 'decisao' exige veredito", () => {
    const divergent = computeDivergentFieldNames(fields, active);
    expect(divergent).toEqual(["decisao"]);
  });

  it("resolvido o campo divergente visível, o parecer fecha (concluido)", () => {
    const divergent = computeDivergentFieldNames(fields, active);
    expect(resolveCompareStatus(divergent, new Set(["decisao"]))).toBe(
      "concluido",
    );
  });
});
