import type { SchemaChangeEntry, SchemaChangeType } from "./types";

export interface ChangeGroup {
  key: string;
  changeType: SchemaChangeType | null;
  version: { major: number; minor: number; patch: number } | null;
  changedBy: string;
  userId: string;
  createdAt: string;
  entries: SchemaChangeEntry[];
}

const GROUPING_WINDOW_MS = 5_000;

export function groupChangesByCommit(entries: SchemaChangeEntry[]): ChangeGroup[] {
  const sorted = entries.toSorted(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const groups: ChangeGroup[] = [];
  for (const entry of sorted) {
    const ts = new Date(entry.createdAt).getTime();
    const last = groups[groups.length - 1];
    const versionMatches =
      (last?.version === null && entry.version === null) ||
      (last?.version &&
        entry.version &&
        last.version.major === entry.version.major &&
        last.version.minor === entry.version.minor &&
        last.version.patch === entry.version.patch);
    // Janela deslizante: compara contra a entry mais antiga já incluída.
    // sorted está em DESC, então o último elemento de `last.entries` é o mais antigo.
    const tail = last?.entries[last.entries.length - 1];
    if (
      last &&
      tail &&
      last.userId === entry.userId &&
      versionMatches &&
      Math.abs(new Date(tail.createdAt).getTime() - ts) <= GROUPING_WINDOW_MS
    ) {
      last.entries.push(entry);
    } else {
      groups.push({
        key: entry.id,
        changeType: entry.changeType,
        version: entry.version,
        changedBy: entry.changedBy,
        userId: entry.userId,
        createdAt: entry.createdAt,
        entries: [entry],
      });
    }
  }
  return groups;
}
