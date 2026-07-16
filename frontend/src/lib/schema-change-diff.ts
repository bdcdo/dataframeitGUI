import { stableStringify } from "./schema-utils";
import {
  normalizeSubfields,
  resolveAllowOther,
  resolveRequired,
  resolveTarget,
} from "./pydantic-field";
import type { FieldCondition, SchemaChangeEntry, SubfieldDef } from "./types";
import type { PydanticFieldTarget } from "./pydantic-field";

export type FieldChangeKind = "added" | "removed" | "renamed" | "modified";

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
    | "condition"
    | "justification_prompt";
  before: unknown;
  after: unknown;
}

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

// stableStringify (não JSON.stringify) — o jsonb do Postgres normaliza a
// ordem das chaves, então before/after vindos do banco podem ter subfields/
// condition com chaves reordenadas em relação ao que foi autorado no
// cliente. Mesma correção de schema-utils.ts (classifyChange/diffFields),
// aplicada aqui para o diff de histórico ficar em sincronia — ver CLAUDE.md
// regra (d) e PR #352.
function subfieldsEqual(
  a: SubfieldDef[] | null | undefined,
  b: SubfieldDef[] | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    stableStringify(normalizeSubfields(a)) ===
    stableStringify(normalizeSubfields(b))
  );
}

function conditionEqual(
  a: FieldCondition | null | undefined,
  b: FieldCondition | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return stableStringify(a) === stableStringify(b);
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
  // Os resolvedores canonicos, e nao `?? null` / `Boolean(...)`, porque este
  // diff le payloads de duas eras: os gravados antes da unificacao de defaults
  // trazem `null` onde a propriedade estava ausente, os novos ja trazem o
  // default resolvido. `Boolean(null)` e `false`, mas o default de `required` e
  // `true` — era por isso que marcar um campo como opcional gravava o log e nao
  // renderizava linha nenhuma (`Boolean(null) !== Boolean(false)` e falso).
  if (has(before, "target") || has(after, "target")) {
    const b = resolveTarget(before.target as PydanticFieldTarget | null | undefined);
    const a = resolveTarget(after.target as PydanticFieldTarget | null | undefined);
    if (b !== a) {
      diffs.push({ property: "target", before: b, after: a });
    }
  }
  if (has(before, "required") || has(after, "required")) {
    const b = resolveRequired(before.required as boolean | null | undefined);
    const a = resolveRequired(after.required as boolean | null | undefined);
    if (b !== a) {
      diffs.push({ property: "required", before: b, after: a });
    }
  }
  if (has(before, "allow_other") || has(after, "allow_other")) {
    const b = resolveAllowOther(before.allow_other as boolean | null | undefined);
    const a = resolveAllowOther(after.allow_other as boolean | null | undefined);
    if (b !== a) {
      diffs.push({ property: "allow_other", before: b, after: a });
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
  if (
    has(before, "justification_prompt") ||
    has(after, "justification_prompt")
  ) {
    if (
      (before.justification_prompt ?? null) !==
      (after.justification_prompt ?? null)
    ) {
      diffs.push({
        property: "justification_prompt",
        before: before.justification_prompt ?? null,
        after: after.justification_prompt ?? null,
      });
    }
  }

  return diffs;
}
