// Funções puras do backfill retroativo de versão de schema
// (schema_change_log). Extraídas de actions/schema.ts: arquivos "use server"
// só podem exportar funções async (regra do Next), então o que é puro e
// testável vive aqui e a action importa.

import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import {
  computeFieldHash,
  bumpVersion,
  fieldDiffIsStructural,
  isProjectScopedLogEntry,
  type ChangeType,
} from "@/lib/schema-utils";
import { formatVersion, versionGte, type SchemaVersion } from "@/lib/compare-version";

export type FieldSnapshot = Partial<PydanticField> & { name: string };

export type Version = SchemaVersion;

export type EnrichedEntry = {
  id: string;
  field_name: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: number;
  changeType: ChangeType;
  version: Version;
};

export type LogEntryRow = {
  id: string;
  field_name: string;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  created_at: string;
  change_type: string | null;
};

export type ResponseRow = {
  id: string;
  created_at: string;
  answer_field_hashes: AnswerFieldHashes;
  version_inferred_from: string | null;
};

export type UpdateBucket = { version: Version; method: string; ids: string[] };

export type BackfillStats = {
  finalVersion: { major: number; minor: number; patch: number };
  logEntriesUpdated: number;
  responsesProcessed: number;
  byMethod: {
    hashes: number;
    created_at: number;
    fallback_created_at: number;
    live_save: number;
  };
};

type InferenceMethod = "hashes" | "created_at" | "fallback_created_at";
type VersionHashes = [key: string, hashes: Record<string, string>];
type KnownHashEntry = [fieldName: string, hash: string];
type VersionInference = { key: string; method: InferenceMethod };

function cloneFieldSnapshot(f: FieldSnapshot): FieldSnapshot {
  return {
    ...f,
    options: f.options ? [...f.options] : f.options,
  };
}

function cloneSnapshotMap(snap: Map<string, FieldSnapshot>): Map<string, FieldSnapshot> {
  const out = new Map<string, FieldSnapshot>();
  for (const [k, v] of snap) out.set(k, cloneFieldSnapshot(v));
  return out;
}

function versionKey(v: { major: number; minor: number; patch: number }) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function computeHashesFromSnapshot(snap: Map<string, FieldSnapshot>): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, field] of snap) {
    if (!field.type || field.description == null) continue;
    hashes[name] = computeFieldHash(
      name,
      field.type,
      field.options ?? null,
      field.description,
    );
  }
  return hashes;
}

// Classifica cada entry (major/minor/patch) e acumula a versão corrente:
// `current` acumula sequencialmente porque a versão de uma entry depende de
// todas as anteriores (semver é cumulativo).
export function classifyLogEntries(log: LogEntryRow[]): {
  enriched: EnrichedEntry[];
  finalVersion: Version;
} {
  let current: Version = { major: 0, minor: 1, patch: 0 };
  const enriched: EnrichedEntry[] = [];

  for (const entry of log) {
    const before = entry.before_value ?? {};
    const after = entry.after_value ?? {};

    const type: ChangeType =
      entry.change_type === "major"
        ? "major"
        : fieldDiffIsStructural(before, after)
          ? "minor"
          : "patch";

    current = bumpVersion(current, type);
    enriched.push({
      id: entry.id,
      field_name: entry.field_name,
      before,
      after,
      createdAt: new Date(entry.created_at).getTime(),
      changeType: type,
      version: { ...current },
    });
  }

  return { enriched, finalVersion: current };
}

export type PersistedLogEntryRow = LogEntryRow & {
  version_major: number | null;
  version_minor: number | null;
  version_patch: number | null;
};

// `non_monotonic` e `current_behind_log` não são erros de leitura: são estados
// do banco que quebram a premissa da reconstrução (ver
// buildTimelineFromPersistedVersions). Voltam como resultado nomeado em vez de
// exceção ou de um Map incompleto porque quem chama precisa poder reportá-los
// como achado próprio — reconstruir por cima deles produz snapshot errado, que
// vira falso positivo silencioso.
export type PersistedTimeline =
  | { status: "ok"; hashesByVersion: Map<string, Record<string, string>> }
  | { status: "non_monotonic"; detail: string }
  | { status: "current_behind_log"; detail: string };

type TimelineCursor = { key: string; version: Version };

function asChangeType(value: string | null): ChangeType | null {
  return value === "major" || value === "minor" || value === "patch" ? value : null;
}

// Devolve a descrição da quebra de ordem, ou null se a entry pode entrar na
// timeline. Versões iguais em sequência são o normal — um lote de save grava
// várias entries na mesma versão — então o critério é não-decrescente, não
// estritamente crescente.
//
// Uma única comparação basta para as DUAS quebras que a reconstrução não
// tolera. O reaparecimento de uma versão já vista (que fundiria num grupo só
// entries de épocas distintas) não precisa de checagem própria: como a
// sequência é não-decrescente até aqui, a última versão é também a maior vista,
// logo qualquer chave já vista e diferente dela é menor — isto é, reaparecer
// implica retroceder. Uma segunda guarda com um Set de chaves vistas seria
// inalcançável; medido por mutação em 2026-07-24 (desativá-la mantinha a suíte
// verde).
function timelineOrderViolation(
  entryId: string,
  key: string,
  version: Version,
  prev: TimelineCursor | null,
): string | null {
  if (!prev) return null;
  if (!versionGte(version, prev.version)) {
    return `entry ${entryId} carrega versão ${key}, anterior à ${prev.key} da entry precedente em (created_at, id)`;
  }
  return null;
}

// Timeline de hashes por versão na ESCALA PERSISTIDA: usa as colunas version_*
// gravadas no schema_change_log, e não a reclassificação de
// `classifyLogEntries`.
//
// A distinção importa porque as duas são réguas diferentes. `classifyLogEntries`
// re-deriva o semver do zero (reclassifica patch→minor por fieldDiffIsStructural
// e bumpa por entry, não por lote de save), então recalcular hoje um log que
// cresceu desde o último backfill dá uma escala inflada — medido no Zolgensma em
// 2026-07-24: 0.38.0 re-derivado contra 0.20.0 persistido. Já o valor
// persistido é o mesmo que `runBackfill` gravou no log e no carimbo das
// responses dentro da MESMA transação (ver apply_schema_backfill): comparar
// response contra coluna persistida compara dois lados congelados juntos.
//
// O prefixo pré-versionamento (entries com version_major NULL, anteriores à
// migration 20260420) é sintetizado replicando os bumps a partir de 0.1.0, e
// cada entry com versão gravada reancora a síntese.
//
// PREMISSA VERIFICADA, NÃO ASSUMIDA: `reconstructSnapshotsByVersion` agrupa por
// versão e reverte os grupos em ordem numérica decrescente, ou seja, trata
// ordem numérica como ordem cronológica. A síntese por entry pode inflar acima
// da primeira versão persistida e furar isso de dois modos — interleaving (os
// grupos revertem fora de ordem e TODOS os snapshots saem errados) e colisão de
// chave (uma chave sintetizada igual a uma persistida funde grupos
// cronologicamente distantes). Por isso o log é auditado antes de reconstruir:
// não-decrescente em (created_at, id) e cada versão contígua. O `log` precisa
// chegar ordenado por (created_at, id).
export function buildTimelineFromPersistedVersions(
  log: PersistedLogEntryRow[],
  fields: PydanticField[],
  currentVersion: Version,
): PersistedTimeline {
  let synth: Version = { major: 0, minor: 1, patch: 0 };
  const enriched: EnrichedEntry[] = [];
  let previous: TimelineCursor | null = null;

  for (const entry of log) {
    const before = entry.before_value ?? {};
    const after = entry.after_value ?? {};
    // `changeType` só governa a síntese do prefixo — `reconstructSnapshotsByVersion`
    // não o lê. Para entries que já trazem versão gravada ele registra o que o
    // log diz, sem re-derivar por fieldDiffIsStructural.
    let changeType: ChangeType;
    let version: Version;
    if (entry.version_major !== null) {
      version = {
        major: entry.version_major,
        minor: entry.version_minor ?? 0,
        patch: entry.version_patch ?? 0,
      };
      synth = version;
      changeType = asChangeType(entry.change_type) ?? "patch";
    } else {
      changeType =
        asChangeType(entry.change_type) ?? (fieldDiffIsStructural(before, after) ? "minor" : "patch");
      synth = bumpVersion(synth, changeType);
      version = synth;
    }

    const key = formatVersion(version);
    const orderProblem = timelineOrderViolation(entry.id, key, version, previous);
    if (orderProblem) return { status: "non_monotonic", detail: orderProblem };
    previous = { key, version };

    enriched.push({
      id: entry.id,
      field_name: entry.field_name,
      before,
      after,
      createdAt: new Date(entry.created_at).getTime(),
      changeType,
      version,
    });
  }

  // A âncora da reconstrução é a versão CORRENTE do projeto, não a da última
  // entry: `fields` é o estado de agora, então é sob a versão de agora que ele
  // deve ser registrado. Quando as duas coincidem o resultado é o mesmo; quando
  // o projeto está à frente (versão avançada sem diff de campo), ancorar na
  // última entry atribuiria o snapshot atual à chave errada e as responses da
  // versão corrente cairiam em "não existe na timeline". O projeto atrás do log
  // é estado impossível — o commit grava os dois na mesma transação — e por
  // isso volta como achado em vez de ser acomodado.
  if (previous && !versionGte(currentVersion, previous.version)) {
    return {
      status: "current_behind_log",
      detail: `versão corrente do projeto ${formatVersion(currentVersion)} é anterior à ${previous.key} da última entry do schema_change_log`,
    };
  }

  const snapshots = reconstructSnapshotsByVersion(fields, enriched, currentVersion);
  const hashesByVersion = new Map<string, Record<string, string>>();
  for (const [key, snap] of snapshots) hashesByVersion.set(key, computeHashesFromSnapshot(snap));
  return { status: "ok", hashesByVersion };
}

// Reconstrói o snapshot de campos em cada versão, andando o log de trás para
// frente (revertendo diffs a partir do estado atual).
export function reconstructSnapshotsByVersion(
  pydanticFields: PydanticField[],
  enriched: EnrichedEntry[],
  finalVersion: Version,
): Map<string, Map<string, FieldSnapshot>> {
  const currentSnap = new Map<string, FieldSnapshot>();
  for (const f of pydanticFields) {
    currentSnap.set(f.name, cloneFieldSnapshot({ ...f }));
  }

  // Map: versionKey -> snapshot map (fieldName -> snapshot)
  const snapByVersion = new Map<string, Map<string, FieldSnapshot>>();
  snapByVersion.set(versionKey(finalVersion), cloneSnapshotMap(currentSnap));

  // Group entries by version so we revert all at once per version-change
  const versionsDesc: Array<{ key: string; version: Version }> = [];
  const entriesByVersion = new Map<string, EnrichedEntry[]>();
  for (const e of enriched) {
    const k = versionKey(e.version);
    if (!entriesByVersion.has(k)) {
      entriesByVersion.set(k, []);
      versionsDesc.push({ key: k, version: e.version });
    }
    entriesByVersion.get(k)!.push(e);
  }
  // Sort desc so we revert from latest → earliest
  versionsDesc.sort((a, b) => {
    if (a.version.major !== b.version.major) return b.version.major - a.version.major;
    if (a.version.minor !== b.version.minor) return b.version.minor - a.version.minor;
    return b.version.patch - a.version.patch;
  });

  const workingSnap = cloneSnapshotMap(currentSnap);
  for (let idx = 0; idx < versionsDesc.length; idx++) {
    const { key } = versionsDesc[idx];
    // Snapshot at version `version` (before reverting) — if not already stored
    if (!snapByVersion.has(key)) {
      snapByVersion.set(key, cloneSnapshotMap(workingSnap));
    }
    // Revert all entries at this version
    const group = entriesByVersion.get(key)!;
    for (const e of group) {
      // Entradas de escopo do projeto (publicação MAJOR, reordenação) não
      // descrevem o estado de nenhum campo — reverter uma delas inventaria um
      // campo com o nome do sentinel no snapshot.
      if (isProjectScopedLogEntry(e.field_name)) continue;
      const isAdd = Object.keys(e.before).length === 0;
      const isRemove = Object.keys(e.after).length === 0;
      if (isAdd) {
        // Pré-E: o campo não existia
        workingSnap.delete(e.field_name);
      } else if (isRemove) {
        // Pré-E: o campo existia como `before`
        const snap = { name: e.field_name, ...(e.before as Partial<PydanticField>) };
        workingSnap.set(e.field_name, snap);
      } else {
        // Campo modificado: reverte atributos listados em `before`
        const existing = workingSnap.get(e.field_name) ?? { name: e.field_name };
        workingSnap.set(e.field_name, {
          ...existing,
          ...(e.before as Partial<PydanticField>),
          name: e.field_name,
        });
      }
    }
    // Após reverter, workingSnap representa a versão anterior
    const prev = versionsDesc[idx + 1];
    if (!prev) {
      // 0.1.0 inicial (pré-primeira entry)
      snapByVersion.set(versionKey({ major: 0, minor: 1, patch: 0 }), cloneSnapshotMap(workingSnap));
    }
  }

  return snapByVersion;
}

function findStructurallyCompatibleVersions(
  hashEntries: [string, string | null][],
  hashesByVersion: Map<string, Record<string, string>>,
): VersionHashes[] {
  return [...hashesByVersion.entries()].filter(([, versionHashes]) =>
    hashEntries.every(([fieldName]) => Object.hasOwn(versionHashes, fieldName)),
  );
}

function findBestHashMatch(
  candidates: VersionHashes[],
  knownHashEntries: KnownHashEntry[],
  versionTs: Map<string, number>,
  responseTs: number,
): string | null {
  const ranked = candidates
    .map(([key, versionHashes]) => ({
      key,
      score: knownHashEntries.filter(([fieldName, hash]) => versionHashes[fieldName] === hash)
        .length,
      timestampDistance: Math.abs((versionTs.get(key) ?? 0) - responseTs),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.timestampDistance - b.timestampDistance);

  return ranked[0]?.key ?? null;
}

function chooseVersionByTimestamp(
  candidateKeys: Iterable<string>,
  versionTs: Map<string, number>,
  responseTs: number,
): string | null {
  const chronological = [...candidateKeys]
    .map((key) => [key, versionTs.get(key) ?? 0] as const)
    .sort((a, b) => a[1] - b[1]);
  const latestNotAfterResponse = chronological.filter(([, timestamp]) => timestamp <= responseTs).at(-1);
  return latestNotAfterResponse?.[0] ?? chronological[0]?.[0] ?? null;
}

function inferResponseVersion(
  response: ResponseRow,
  hashesByVersion: Map<string, Record<string, string>>,
  versionTs: Map<string, number>,
): VersionInference {
  const hashEntries = Object.entries(response.answer_field_hashes ?? {});
  const responseTs = new Date(response.created_at).getTime();

  if (hashEntries.length === 0) {
    return {
      key:
        chooseVersionByTimestamp(versionTs.keys(), versionTs, responseTs) ??
        versionKey({ major: 0, minor: 1, patch: 0 }),
      method: "created_at",
    };
  }

  // Toda chave prova que o campo existia, mesmo quando o hash é null. Apenas
  // hashes conhecidos pontuam as versões que contêm todos esses campos.
  const compatibleVersions = findStructurallyCompatibleVersions(hashEntries, hashesByVersion);
  const knownHashEntries = hashEntries.filter(
    (entry): entry is KnownHashEntry => entry[1] !== null,
  );
  const hashMatch = findBestHashMatch(
    compatibleVersions,
    knownHashEntries,
    versionTs,
    responseTs,
  );
  if (hashMatch) return { key: hashMatch, method: "hashes" };

  const compatibleTimestampMatch = chooseVersionByTimestamp(
    compatibleVersions.map(([key]) => key),
    versionTs,
    responseTs,
  );
  return {
    key:
      compatibleTimestampMatch ??
      chooseVersionByTimestamp(versionTs.keys(), versionTs, responseTs) ??
      versionKey({ major: 0, minor: 1, patch: 0 }),
    method: "fallback_created_at",
  };
}

// Escolhe a versão de cada response (por hash de campos, com fallback em
// created_at) e agrupa em buckets por (versão, método).
export function matchResponsesToVersions(
  responses: ResponseRow[],
  hashesByVersion: Map<string, Record<string, string>>,
  enriched: EnrichedEntry[],
): { updates: Map<string, UpdateBucket>; byMethod: BackfillStats["byMethod"] } {
  const versionByKey = new Map<string, Version>();
  for (const k of hashesByVersion.keys()) {
    const [mj, mn, pt] = k.split(".").map((n) => Number.parseInt(n, 10));
    versionByKey.set(k, { major: mj, minor: mn, patch: pt });
  }
  // Timestamp of each version (from entries; initial version = 0)
  const versionTs = new Map<string, number>();
  for (const e of enriched) {
    const k = versionKey(e.version);
    if (!versionTs.has(k)) versionTs.set(k, e.createdAt);
  }
  versionTs.set(versionKey({ major: 0, minor: 1, patch: 0 }), 0);

  const updates = new Map<string, UpdateBucket>();
  const byMethod: BackfillStats["byMethod"] = {
    hashes: 0,
    created_at: 0,
    fallback_created_at: 0,
    live_save: 0,
  };

  for (const r of responses) {
    // Preserve live_save entries as-is (precisão total)
    if (r.version_inferred_from === "live_save") {
      byMethod.live_save++;
      continue;
    }

    const inference = inferResponseVersion(r, hashesByVersion, versionTs);
    const v = versionByKey.get(inference.key) ?? { major: 0, minor: 1, patch: 0 };
    const bucketKey = `${inference.key}|${inference.method}`;
    if (!updates.has(bucketKey)) {
      updates.set(bucketKey, { version: v, method: inference.method, ids: [] });
    }
    updates.get(bucketKey)!.ids.push(r.id);
    byMethod[inference.method]++;
  }

  return { updates, byMethod };
}
