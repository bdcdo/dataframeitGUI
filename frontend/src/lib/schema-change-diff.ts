import { stableStringify } from "./schema-utils";
import {
  normalizeSubfields,
  resolveAllowOther,
  resolveOptionalText,
  resolveRequired,
  resolveSubfieldRule,
  resolveTarget,
} from "./pydantic-field";
import type { FieldCondition, SchemaChangeEntry, SubfieldDef } from "./types";
import type { PydanticFieldTarget, PydanticSubfieldRule } from "./pydantic-field";

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
    | "justification_prompt"
    | "question_revision";
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
// `normalizeSubfields` antes do stringify pela mesma razao que `snapshotOf` o
// usa: o backend sempre grava `required` no subcampo e o dado legado pode nao
// ter a chave, entao comparar cru acusaria mudanca onde so ha default
// explicitado (issue #491).
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
    const b = resolveOptionalText(before.help_text as string | null | undefined);
    const a = resolveOptionalText(after.help_text as string | null | undefined);
    if (b !== a) {
      diffs.push({ property: "help_text", before: b, after: a });
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
  // O lado inteiro vazio (campo adicionado ou removido) e outra coisa: nao ha
  // campo ali para ter o default, e mostra-lo como valor dizia que o campo
  // removido tinha passado a "Todos". A comparacao segue pelo resolvedor; so a
  // exibicao do lado vazio vira `null`.
  const beforeGone = isEmptySnapshot(before);
  const afterGone = isEmptySnapshot(after);
  if (has(before, "target") || has(after, "target")) {
    const b = resolveTarget(before.target as PydanticFieldTarget | null | undefined);
    const a = resolveTarget(after.target as PydanticFieldTarget | null | undefined);
    if (b !== a) {
      diffs.push({
        property: "target",
        before: beforeGone ? null : b,
        after: afterGone ? null : a,
      });
    }
  }
  if (has(before, "required") || has(after, "required")) {
    const b = resolveRequired(before.required as boolean | null | undefined);
    const a = resolveRequired(after.required as boolean | null | undefined);
    if (b !== a) {
      diffs.push({
        property: "required",
        before: beforeGone ? null : b,
        after: afterGone ? null : a,
      });
    }
  }
  if (has(before, "allow_other") || has(after, "allow_other")) {
    const b = resolveAllowOther(before.allow_other as boolean | null | undefined);
    const a = resolveAllowOther(after.allow_other as boolean | null | undefined);
    if (b !== a) {
      diffs.push({
        property: "allow_other",
        before: beforeGone ? null : b,
        after: afterGone ? null : a,
      });
    }
  }
  if (has(before, "subfield_rule") || has(after, "subfield_rule")) {
    const b = resolveSubfieldRule(before.subfield_rule as PydanticSubfieldRule | null | undefined);
    const a = resolveSubfieldRule(after.subfield_rule as PydanticSubfieldRule | null | undefined);
    if (b !== a) {
      diffs.push({
        property: "subfield_rule",
        before: beforeGone ? null : b,
        after: afterGone ? null : a,
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
    const b = resolveOptionalText(before.justification_prompt as string | null | undefined);
    const a = resolveOptionalText(after.justification_prompt as string | null | undefined);
    if (b !== a) {
      diffs.push({ property: "justification_prompt", before: b, after: a });
    }
  }

  // Ausente e `null` são "nenhuma revisão"; o renderizador mostra o número
  // como texto curto.
  if (has(before, "question_revision") || has(after, "question_revision")) {
    const b = (before.question_revision as number | null | undefined) ?? null;
    const a = (after.question_revision as number | null | undefined) ?? null;
    if (b !== a) {
      diffs.push({ property: "question_revision", before: b, after: a });
    }
  }

  return diffs;
}
