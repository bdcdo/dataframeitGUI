// Primitivas puras de versão de schema para a aba Comparar.
//
// Vivem num módulo próprio (sem `server-only`, sem React) para serem
// compartilhadas entre o Server Component da página (compare/page.tsx) e a
// Server Action de sincronização (compare-sync.ts), e para serem testáveis por
// Vitest. Antes, `versionGte`/`parseVersionStr`/`resolveMinVersion` viviam
// inline e não-exportadas em compare/page.tsx, e o predicado de qualificação
// por versão estava duplicado de forma divergente em compare-sync.ts — drift
// que era a causa do assignment de comparação não fechar (ver #168 e o
// princípio anti-drift do CLAUDE.md, mesmo racional do #63 para schema-utils).

export interface SchemaVersion {
  major: number;
  minor: number;
  patch: number;
}

// Campos mínimos de uma resposta necessários para decidir se ela qualifica sob
// um piso de versão. Tanto `CompareResponse` (página) quanto a linha buscada em
// compare-sync.ts satisfazem este shape.
export interface VersionedResponse {
  respondent_type: "humano" | "llm";
  is_latest: boolean;
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}

// Compara (a) >= (b) em ordem semver major > minor > patch.
export function versionGte(a: SchemaVersion, b: SchemaVersion): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

export function parseVersionStr(s: string): SchemaVersion | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
  };
}

export function formatVersion(v: SchemaVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// Piso de versão para o filtro "última grande versão".
//
// Em projetos major ≥ 1 a fronteira de rodada é o MAJOR corrente
// (`{major,0,0}`). Mas projetos costumam viver inteiros em `0.x`: MINOR é
// bumpado automaticamente a cada save de schema e MAJOR é um gesto manual raro
// do coordenador. Em `0.x` nunca houve quebra MAJOR, então ancorar em
// `{0,0,0}` aceitaria TODAS as minors e o filtro não separaria rodada nenhuma
// (bug: respostas de schemas antigos misturadas com as atuais). Para major 0,
// a fronteira significativa é o MINOR corrente (`{0,minor,0}`); patch é
// cosmético e não invalida respostas, então o piso mantém todos os patches da
// minor corrente.
export function latestMajorAnchor(v: SchemaVersion): SchemaVersion {
  if (v.major === 0) return { major: 0, minor: v.minor, patch: 0 };
  return { major: v.major, minor: 0, patch: 0 };
}

// Resolve o filtro de versão da UI num piso `SchemaVersion` (ou null = sem
// filtro). `filter` é `CompareFiltersValue["version"]`: "all" | "latest_major"
// | "X.Y.Z".
export function resolveMinVersion(
  filter: string,
  projectCurrent: SchemaVersion,
): SchemaVersion | null {
  if (filter === "all") return null;
  if (filter === "latest_major") return latestMajorAnchor(projectCurrent);
  return parseVersionStr(filter);
}

// Contexto de versão do projeto, necessário para o fallback por hash abaixo.
export interface ProjectVersionContext {
  pydanticHash: string | null;
  version: SchemaVersion;
}

// Predicado único de qualificação de uma resposta sob um piso de versão.
// Regras, nesta ordem:
//   1. respostas superseded (is_latest=false) ficam de fora — humanas OU LLM.
//      Após o PR #213, uma codificação humana rebaixada (ao promover uma versão
//      mais recente no dedup de documentos, ou após unificação de membros) tem
//      is_latest=false e não deve reaparecer como segundo card / inflar a
//      contagem. Antes a cláusula mantinha humano por engano;
//   2. sem filtro de versão (minVersion null = filtro "all"), qualifica;
//   3. respostas pré-versionamento (pydantic_hash NULL, gravadas antes da
//      migration 20260420) são descartadas com filtro ativo — não há como
//      situá-las;
//   4. com semver gravado (fonte de verdade), a versão da resposta precisa ser
//      >= o piso;
//   5. SEM semver gravado: as respostas LLM nascem com schema_version NULL
//      porque o backend não popula esses campos no insert (o B1 deste PR passa
//      a popular, mas só nos inserts futuros; as respostas legadas seguem NULL
//      até um backfill). Para não esvaziar a comparação, usamos o
//      `pydantic_hash` — que é sempre gravado — como proxy: se bate com o hash
//      atual do projeto, a resposta é da versão corrente e qualifica sob
//      qualquer piso <= corrente; senão é de um schema anterior e é descartada.
// NÃO inclui os filtros efêmeros de UI (`since`, `respondent`): esses são
// aplicados só na página, não na decisão de conclusão do assignment.
export function responseQualifiesForVersion(
  r: VersionedResponse,
  minVersion: SchemaVersion | null,
  project: ProjectVersionContext,
): boolean {
  if (!r.is_latest) return false;
  if (!minVersion) return true;
  if (r.pydantic_hash === null) return false;
  if (r.schema_version_major !== null) {
    const rv: SchemaVersion = {
      major: r.schema_version_major ?? 0,
      minor: r.schema_version_minor ?? 0,
      patch: r.schema_version_patch ?? 0,
    };
    return versionGte(rv, minVersion);
  }
  if (project.pydanticHash !== null && r.pydantic_hash === project.pydanticHash) {
    return versionGte(project.version, minVersion);
  }
  return false;
}
