// Funções puras do backfill retroativo de versão de schema
// (schema_change_log). Extraídas de actions/schema.ts: arquivos "use server"
// só podem exportar funções async (regra do Next), então o que é puro e
// testável vive aqui e a action importa.

import type { PydanticField } from "@/lib/types";
import {
  computeFieldHash,
  bumpVersion,
  fieldDiffIsStructural,
  isProjectScopedLogEntry,
  type ChangeType,
} from "@/lib/schema-utils";
import type { SchemaVersion } from "@/lib/compare-version";

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
  answer_field_hashes: Record<string, string> | null;
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

  // Bucket updates by (version, method)
  const updates = new Map<string, UpdateBucket>();
  let countLiveSave = 0;
  let countHashes = 0;
  let countCreatedAt = 0;
  let countFallback = 0;

  for (const r of responses) {
    // Preserve live_save entries as-is (precisão total)
    if (r.version_inferred_from === "live_save") {
      countLiveSave++;
      continue;
    }

    const rHashes = r.answer_field_hashes ?? null;
    const ts = new Date(r.created_at).getTime();

    let chosenKey: string | null = null;
    let chosenMethod: "hashes" | "created_at" | "fallback_created_at" = "created_at";

    if (rHashes && Object.keys(rHashes).length > 0) {
      // Score each version
      let bestScore = -1;
      let bestKey: string | null = null;
      let bestTieTs = Infinity;
      for (const [k, vHashes] of hashesByVersion) {
        let score = 0;
        for (const [fn, h] of Object.entries(rHashes)) {
          if (vHashes[fn] === h) score++;
        }
        if (score === 0) continue;
        const kTs = versionTs.get(k) ?? 0;
        const tieMetric = Math.abs(kTs - ts);
        if (score > bestScore || (score === bestScore && tieMetric < bestTieTs)) {
          bestScore = score;
          bestKey = k;
          bestTieTs = tieMetric;
        }
      }
      if (bestKey) {
        chosenKey = bestKey;
        chosenMethod = "hashes";
      }
    }

    if (!chosenKey) {
      // Fallback timestamp
      const candidates = [...versionTs.entries()]
        .filter(([, t]) => t <= ts)
        .sort((a, b) => b[1] - a[1]);
      chosenKey =
        candidates.length > 0 ? candidates[0][0] : versionKey({ major: 0, minor: 1, patch: 0 });
      chosenMethod =
        rHashes && Object.keys(rHashes).length > 0 ? "fallback_created_at" : "created_at";
    }

    const v = versionByKey.get(chosenKey) ?? { major: 0, minor: 1, patch: 0 };
    const bucketKey = `${chosenKey}|${chosenMethod}`;
    if (!updates.has(bucketKey)) {
      updates.set(bucketKey, { version: v, method: chosenMethod, ids: [] });
    }
    updates.get(bucketKey)!.ids.push(r.id);

    if (chosenMethod === "hashes") countHashes++;
    else if (chosenMethod === "created_at") countCreatedAt++;
    else if (chosenMethod === "fallback_created_at") countFallback++;
  }

  return {
    updates,
    byMethod: {
      hashes: countHashes,
      created_at: countCreatedAt,
      fallback_created_at: countFallback,
      live_save: countLiveSave,
    },
  };
}
