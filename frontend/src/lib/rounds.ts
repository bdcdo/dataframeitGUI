import type { RoundStrategy, Round } from "./types";

export interface SchemaVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface RoundContext {
  strategy: RoundStrategy;
  currentRoundId: string | null;
  currentVersion: SchemaVersion;
  rounds: Round[];
}

export interface ResponseRoundFields {
  round_id?: string | null;
  schema_version_major?: number | null;
  schema_version_minor?: number | null;
  schema_version_patch?: number | null;
  is_partial?: boolean | null;
}

export function versionLabel(v: SchemaVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function versionEquals(a: SchemaVersion, b: SchemaVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

export function responseRoundLabel(
  ctx: RoundContext,
  response: ResponseRoundFields | null | undefined,
  roundsById: Map<string, Round>,
): string | null {
  if (!response) return null;
  if (ctx.strategy === "manual") {
    if (!response.round_id) return null;
    return roundsById.get(response.round_id)?.label ?? null;
  }
  const m = response.schema_version_major;
  const n = response.schema_version_minor;
  const p = response.schema_version_patch;
  if (m == null || n == null || p == null) return null;
  return `${m}.${n}.${p}`;
}

export type DocRoundStatus =
  | { kind: "current_pending" }
  | { kind: "current_done" }
  | { kind: "previous"; label: string }
  | { kind: "no_response" };

export function classifyDocStatus(
  ctx: RoundContext,
  response: ResponseRoundFields | null | undefined,
  roundsById: Map<string, Round>,
): DocRoundStatus {
  if (!response) return { kind: "no_response" };

  // Resposta parcial (autosave em andamento) ainda precisa ser concluida —
  // tratar como pendente da rodada atual independente de schema/round_id.
  if (response.is_partial === true) return { kind: "current_pending" };

  if (ctx.strategy === "manual") {
    if (!ctx.currentRoundId) {
      // Estrategia manual mas nao ha rodada atual definida.
      // Tudo vira "sem rodada" / pendente.
      return { kind: "current_pending" };
    }
    if (response.round_id === ctx.currentRoundId) {
      return { kind: "current_done" };
    }
    // Guardrail: com FK responses.round_id ON DELETE SET NULL, round_id de uma
    // rodada removida vira null (cai no branch "Sem rodada") — o lookup falhar
    // com label "Rodada removida" so deve ocorrer em estado intermediario.
    const label = response.round_id
      ? roundsById.get(response.round_id)?.label ?? "Rodada removida"
      : "Sem rodada";
    return { kind: "previous", label };
  }

  // schema_version
  const m = response.schema_version_major;
  const n = response.schema_version_minor;
  const p = response.schema_version_patch;
  if (m == null || n == null || p == null) return { kind: "current_pending" };
  const v: SchemaVersion = { major: m, minor: n, patch: p };
  if (versionEquals(v, ctx.currentVersion)) return { kind: "current_done" };
  return { kind: "previous", label: versionLabel(v) };
}

/**
 * Identificadores possiveis para o filtro de rodada na URL (`?round=`).
 *  - "current": padrao, mostra docs pendentes da rodada atual
 *  - "all": mostra tudo (comportamento legacy)
 *  - rodada manual: id (UUID)
 *  - rodada schema_version: label "X.Y.Z"
 */
export type RoundFilterValue = "current" | "all" | string;

export function isCurrentFilter(value: string | null | undefined): boolean {
  return !value || value === "current";
}

export interface CurrentRoundDescriptor {
  /** Identificador estavel da rodada atual usado em URLs/comparacoes. */
  key: string;
  /** Texto apresentado ao usuario. */
  label: string;
}

export function getCurrentRoundDescriptor(
  ctx: RoundContext,
  roundsById: Map<string, Round>,
): CurrentRoundDescriptor {
  if (ctx.strategy === "manual") {
    if (!ctx.currentRoundId) {
      return { key: "", label: "Sem rodada atual" };
    }
    const label = roundsById.get(ctx.currentRoundId)?.label ?? "Sem rodada atual";
    return { key: ctx.currentRoundId, label };
  }
  const v = versionLabel(ctx.currentVersion);
  return { key: v, label: v };
}
