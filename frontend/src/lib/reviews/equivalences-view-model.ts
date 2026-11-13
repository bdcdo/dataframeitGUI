import { currentValueEquivalences, type ValueEquivalence } from "@/lib/equivalence";
import { equivalenceClasses } from "@/lib/value-equivalence-usage";
import { formatCardAnswer } from "@/lib/verdict-display";
import type { PydanticField } from "@/lib/types";

// Modelo de exibição da aba Revisões > Equivalências, puro: a página busca as
// linhas e passa por aqui, e a view só renderiza.

export interface EquivalenceRowView {
  id: string;
  /** "A = B", já formatado. */
  display: string;
  reviewerName: string;
  createdAt: string | null;
  sourceLabel: string;
  canUndo: boolean;
}

export interface EquivalenceClassRowView {
  classKey: string;
  /** Os valores fundidos pela classe, já formatados. */
  values: string[];
  equivalences: EquivalenceRowView[];
}

export interface EquivalenceFieldView {
  name: string;
  label: string;
  classes: EquivalenceClassRowView[];
}

export interface EquivalenceHistoryView {
  id: string;
  fieldLabel: string;
  display: string;
  reasonLabel: string;
  supersededAt: string;
  reviewerName: string;
}

export type EquivalenceRowWithMeta = ValueEquivalence & { source: string; created_at: string };

export interface EquivalenceHistoryRow {
  id: string;
  field_name: string;
  value_a: unknown;
  value_b: unknown;
  reviewer_id: string | null;
  superseded_at: string;
  superseded_reason: string;
}

const SOURCE_LABELS: Record<string, string> = {
  comparacao: "Comparação",
  llm_insights: "Erros LLM",
  auto_revisao: "Auto-revisão",
  migracao: "Par antigo migrado",
};

const REASON_LABELS: Record<string, string> = {
  manually_removed: "Desfeita",
  question_changed: "Pergunta alterada",
  field_removed: "Campo removido ou renomeado",
};

function displayValue(value: unknown): string {
  return formatCardAnswer(value) || "(vazio)";
}

function displayPair(row: { value_a: unknown; value_b: unknown }): string {
  return `${displayValue(row.value_a)} = ${displayValue(row.value_b)}`;
}

function fieldLabel(field: Pick<PydanticField, "name" | "description">): string {
  return field.description || field.name;
}

export interface ViewerAuthority {
  /** Coordenação, criadora ou master: desfaz qualquer equivalência. */
  isCoordinator: boolean;
  /** Identidade de trabalho de quem vê; desfaz as próprias. */
  memberUserId: string | null;
}

function canUndo(reviewerId: string | null, viewer: ViewerAuthority): boolean {
  return viewer.isCoordinator || (viewer.memberUserId !== null && reviewerId === viewer.memberUserId);
}

/**
 * Por campo do schema, na ordem dele, as classes das equivalências da versão
 * atual da pergunta. Campo sem equivalência fica de fora. `canUndo` só liga o
 * botão: a RPC remove_value_equivalence recheca dono e coordenação.
 */
export function buildEquivalenceFieldViews(
  fields: readonly PydanticField[],
  rows: readonly EquivalenceRowWithMeta[],
  nameOf: ReadonlyMap<string, string>,
  viewer: ViewerAuthority,
): EquivalenceFieldView[] {
  const metaOf = new Map(rows.map((row) => [row.id, row]));
  const views: EquivalenceFieldView[] = [];
  for (const field of fields) {
    const current = currentValueEquivalences(rows, field);
    if (current.length === 0) continue;
    views.push({
      name: field.name,
      label: fieldLabel(field),
      classes: equivalenceClasses(current).map((cls) => ({
        classKey: cls.classKey,
        values: cls.values.map(displayValue),
        equivalences: cls.equivalences.map((equivalence) => ({
          id: equivalence.id,
          display: displayPair(equivalence),
          reviewerName: (equivalence.reviewer_id && nameOf.get(equivalence.reviewer_id)) || "—",
          createdAt: metaOf.get(equivalence.id)?.created_at ?? null,
          sourceLabel: SOURCE_LABELS[metaOf.get(equivalence.id)?.source ?? ""] ?? "—",
          canUndo: canUndo(equivalence.reviewer_id, viewer),
        })),
      })),
    });
  }
  return views;
}

export function buildEquivalenceHistoryViews(
  fields: readonly PydanticField[],
  rows: readonly EquivalenceHistoryRow[],
  nameOf: ReadonlyMap<string, string>,
): EquivalenceHistoryView[] {
  const labelOf = new Map(fields.map((field) => [field.name, fieldLabel(field)]));
  return rows.map((row) => ({
    id: row.id,
    fieldLabel: labelOf.get(row.field_name) ?? row.field_name,
    display: displayPair(row),
    reasonLabel: REASON_LABELS[row.superseded_reason] ?? row.superseded_reason,
    supersededAt: row.superseded_at,
    reviewerName: (row.reviewer_id && nameOf.get(row.reviewer_id)) || "—",
  }));
}
