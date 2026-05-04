import type {
  FieldCondition,
  SchemaChangeEntry,
  SchemaChangeType,
  SubfieldDef,
} from "./types";

export type FieldChangeKind = "added" | "removed" | "renamed" | "modified";

export interface ChangeGroup {
  key: string;
  changeType: SchemaChangeType | null;
  version: { major: number; minor: number; patch: number } | null;
  changedBy: string;
  userId: string;
  createdAt: string;
  entries: SchemaChangeEntry[];
}

export interface FieldPropertyDiff {
  property:
    | "name"
    | "description"
    | "help_text"
    | "options"
    | "type"
    | "target"
    | "required"
    | "allow_other"
    | "subfield_rule"
    | "subfields"
    | "condition";
  before: unknown;
  after: unknown;
}

const GROUPING_WINDOW_MS = 5_000;

function isEmptySnapshot(v: Record<string, unknown> | null | undefined): boolean {
  if (!v) return true;
  if (typeof v !== "object") return true;
  return Object.keys(v).length === 0;
}

export function detectFieldChangeKind(entry: SchemaChangeEntry): FieldChangeKind {
  const beforeEmpty = isEmptySnapshot(entry.beforeValue);
  const afterEmpty = isEmptySnapshot(entry.afterValue);
  if (beforeEmpty && !afterEmpty) return "added";
  if (!beforeEmpty && afterEmpty) return "removed";
  const beforeName = (entry.beforeValue?.name as string | undefined) ?? entry.fieldName;
  const afterName = (entry.afterValue?.name as string | undefined) ?? entry.fieldName;
  if (beforeName !== afterName) return "renamed";
  return "modified";
}

function arraysEqual<T>(a: T[] | null | undefined, b: T[] | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function subfieldsEqual(
  a: SubfieldDef[] | null | undefined,
  b: SubfieldDef[] | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function conditionEqual(
  a: FieldCondition | null | undefined,
  b: FieldCondition | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffPydanticField(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldPropertyDiff[] {
  const diffs: FieldPropertyDiff[] = [];
  const has = (obj: Record<string, unknown>, key: string) =>
    Object.prototype.hasOwnProperty.call(obj ?? {}, key);

  if (has(before, "name") || has(after, "name")) {
    if (before.name !== after.name) {
      diffs.push({ property: "name", before: before.name, after: after.name });
    }
  }
  if (has(before, "description") || has(after, "description")) {
    if (before.description !== after.description) {
      diffs.push({
        property: "description",
        before: before.description,
        after: after.description,
      });
    }
  }
  if (has(before, "help_text") || has(after, "help_text")) {
    if ((before.help_text ?? null) !== (after.help_text ?? null)) {
      diffs.push({
        property: "help_text",
        before: before.help_text ?? null,
        after: after.help_text ?? null,
      });
    }
  }
  if (has(before, "options") || has(after, "options")) {
    const b = (before.options as string[] | null | undefined) ?? null;
    const a = (after.options as string[] | null | undefined) ?? null;
    if (!arraysEqual(b, a)) {
      diffs.push({ property: "options", before: b, after: a });
    }
  }
  if (has(before, "type") || has(after, "type")) {
    if (before.type !== after.type) {
      diffs.push({ property: "type", before: before.type, after: after.type });
    }
  }
  if (has(before, "target") || has(after, "target")) {
    if ((before.target ?? null) !== (after.target ?? null)) {
      diffs.push({
        property: "target",
        before: before.target ?? null,
        after: after.target ?? null,
      });
    }
  }
  if (has(before, "required") || has(after, "required")) {
    if (Boolean(before.required) !== Boolean(after.required)) {
      diffs.push({
        property: "required",
        before: Boolean(before.required),
        after: Boolean(after.required),
      });
    }
  }
  if (has(before, "allow_other") || has(after, "allow_other")) {
    if (Boolean(before.allow_other) !== Boolean(after.allow_other)) {
      diffs.push({
        property: "allow_other",
        before: Boolean(before.allow_other),
        after: Boolean(after.allow_other),
      });
    }
  }
  if (has(before, "subfield_rule") || has(after, "subfield_rule")) {
    if ((before.subfield_rule ?? null) !== (after.subfield_rule ?? null)) {
      diffs.push({
        property: "subfield_rule",
        before: before.subfield_rule ?? null,
        after: after.subfield_rule ?? null,
      });
    }
  }
  if (has(before, "subfields") || has(after, "subfields")) {
    const b = (before.subfields as SubfieldDef[] | null | undefined) ?? null;
    const a = (after.subfields as SubfieldDef[] | null | undefined) ?? null;
    if (!subfieldsEqual(b, a)) {
      diffs.push({ property: "subfields", before: b, after: a });
    }
  }
  if (has(before, "condition") || has(after, "condition")) {
    const b = (before.condition as FieldCondition | null | undefined) ?? null;
    const a = (after.condition as FieldCondition | null | undefined) ?? null;
    if (!conditionEqual(b, a)) {
      diffs.push({ property: "condition", before: b, after: a });
    }
  }

  return diffs;
}

export function groupChangesByCommit(entries: SchemaChangeEntry[]): ChangeGroup[] {
  const sorted = [...entries].sort(
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

export function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 60_000) return "agora";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `há ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} ${hours === 1 ? "hora" : "horas"}`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

export function formatVersion(
  v: { major: number; minor: number; patch: number } | null,
): string {
  if (!v) return "—";
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function formatCondition(c: FieldCondition | null | undefined): string {
  if (!c) return "sem condição";
  if ("equals" in c) return `${c.field} = ${formatScalar(c.equals)}`;
  if ("not_equals" in c) return `${c.field} ≠ ${formatScalar(c.not_equals)}`;
  if ("in" in c) return `${c.field} ∈ [${c.in.map(formatScalar).join(", ")}]`;
  if ("not_in" in c) return `${c.field} ∉ [${c.not_in.map(formatScalar).join(", ")}]`;
  if ("exists" in c) return c.exists ? `${c.field} existe` : `${c.field} ausente`;
  return "sem condição";
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

const TARGET_LABELS: Record<string, string> = {
  all: "Todos",
  llm_only: "Só LLM",
  human_only: "Só humano",
  none: "Nenhum",
};

export function formatTarget(t: unknown): string {
  if (typeof t !== "string") return "—";
  return TARGET_LABELS[t] ?? t;
}

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto",
  date: "Data",
};

export function formatType(t: unknown): string {
  if (typeof t !== "string") return "—";
  return TYPE_LABELS[t] ?? t;
}

const PROPERTY_LABELS: Record<FieldPropertyDiff["property"], string> = {
  name: "nome",
  description: "descrição",
  help_text: "instruções",
  options: "opções",
  type: "tipo",
  target: "alvo",
  required: "obrigatoriedade",
  allow_other: "permite outro",
  subfield_rule: "regra de subcampos",
  subfields: "subcampos",
  condition: "condição",
};

export function propertyLabel(p: FieldPropertyDiff["property"]): string {
  return PROPERTY_LABELS[p];
}
