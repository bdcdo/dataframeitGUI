import "server-only";

import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import {
  FIELD_NAME_PATTERN,
  fetchProjectValueEquivalences,
} from "@/lib/value-equivalence-query";
import { drainAutoReviewReconciliationRequests } from "@/lib/auto-review-reconciler";
import { resyncProjectCompareAssignments } from "@/lib/compare-assignment-sync";
import { affectedValueKeys, equivalenceValueKey } from "@/lib/equivalence";
import { errorMessage } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";

// O que muda fora do documento quando uma equivalência de valor nasce ou é
// desfeita. Ela vale no projeto inteiro, então a divergência muda em todo
// documento que tem um dos valores da classe: a fila da Comparação e a
// auto-revisão desses documentos precisam ser recalculadas.

/**
 * Documentos em que alguma resposta vigente ao campo tem um dos valores. Lê
 * só o valor do campo (caminho JSON), não o `answers` inteiro.
 */
export async function documentsWithValues(
  admin: ReturnType<typeof createSupabaseAdmin>,
  projectId: string,
  fieldName: string,
  valueKeys: ReadonlySet<string>,
): Promise<string[]> {
  if (valueKeys.size === 0) return [];
  if (!FIELD_NAME_PATTERN.test(fieldName)) {
    throw new Error(`nome de campo inválido: ${fieldName}`);
  }
  // Tipado como `string` para o parser de select do supabase-js não tentar
  // inferir o caminho dinâmico.
  const columns: string = `id, document_id, value:answers->${fieldName}`;
  const { data, error } = await fetchAllPaged<{ document_id: string; value: unknown }>(
    () =>
      admin
        .from("responses")
        .select(columns)
        .eq("project_id", projectId)
        .eq("is_latest", true)
        // `answers->campo` é SQL NULL só sem a chave (o JSON null é `'null'`):
        // a resposta que não respondeu o campo fica de fora, como na
        // Comparação, e não se confunde com quem respondeu null.
        .not(`answers->${fieldName}`, "is", null)
        .returns<Array<{ document_id: string; value: unknown }>>(),
    ["id"],
  );
  if (error) throw new Error(`responses: ${error.message}`);
  const documents = new Set<string>();
  for (const row of data) {
    if (valueKeys.has(equivalenceValueKey(row.value))) documents.add(row.document_id);
  }
  return [...documents];
}

/**
 * As chaves afetadas por uma equivalência recém-gravada: os valores fundidos
 * (dados, ou lidos das respostas que o revisor fundiu) e a classe de cada um,
 * já com a equivalência nova.
 */
async function affectedKeysForNewEquivalence(
  admin: ReturnType<typeof createSupabaseAdmin>,
  projectId: string,
  fieldName: string,
  source: { responseIds: readonly string[] } | { values: readonly unknown[] },
): Promise<Set<string>> {
  const [responses, equivalences, project] = await Promise.all([
    "responseIds" in source
      ? admin.from("responses").select("id, answers").eq("project_id", projectId).in("id", [...source.responseIds])
      : Promise.resolve({ data: [] as Array<{ answers: unknown }>, error: null }),
    fetchProjectValueEquivalences(admin, projectId),
    admin.from("projects").select("pydantic_fields").eq("id", projectId).single(),
  ]);
  if (responses.error) throw new Error(`responses: ${responses.error.message}`);
  if (equivalences.error) throw new Error(`value_equivalences: ${equivalences.error.message}`);
  if (project.error) throw new Error(`projects: ${project.error.message}`);
  const field = ((project.data?.pydantic_fields ?? []) as PydanticField[]).find(
    (candidate) => candidate.name === fieldName,
  );
  const values =
    "values" in source
      ? source.values
      : (responses.data ?? []).map(
          (row) => (row.answers as Record<string, unknown> | null)?.[fieldName],
        );
  return affectedValueKeys(equivalences.data, field, values);
}

export type ValueEquivalenceChange = { fieldName: string } & (
  | { valueKeys: ReadonlySet<string> }
  | { responseIds: readonly string[] }
  | { values: readonly unknown[] }
);

/**
 * Pós-commit, fora do caminho da resposta ao clique: enfileira e drena UMA vez
 * a reconciliação da auto-revisão dos documentos afetados pelas mudanças (uma
 * por campo) e ressincroniza as comparações só desses documentos. Admin client
 * porque a RLS de quem clicou não alcança os assignments de outros revisores
 * nem a fila de reconciliação; a autorização da mudança já foi provada pela
 * RPC que a gravou. Falha só é registrada: a equivalência já está gravada, e
 * o próximo save ou o reparo do coordenador recalculam.
 */
export async function propagateValueEquivalenceChange(input: {
  projectId: string;
  changes: readonly ValueEquivalenceChange[];
}): Promise<void> {
  const { projectId, changes } = input;
  try {
    const admin = createSupabaseAdmin();
    const perChange = await Promise.all(
      changes.map(async (change) => {
        const valueKeys =
          "valueKeys" in change
            ? change.valueKeys
            : await affectedKeysForNewEquivalence(admin, projectId, change.fieldName, change);
        return documentsWithValues(admin, projectId, change.fieldName, valueKeys);
      }),
    );
    const documentIds = new Set(perChange.flat());
    if (documentIds.size === 0) return;
    const { error } = await admin.rpc("enqueue_auto_review_reconciliation_for_documents", {
      p_project_id: projectId,
      p_document_ids: [...documentIds],
    });
    if (error) throw new Error(error.message);
    await drainAutoReviewReconciliationRequests({ projectId });
    await resyncProjectCompareAssignments(admin, projectId, { documentIds: [...documentIds] });
  } catch (e) {
    console.error(
      `[value-equivalence] ${JSON.stringify({
        event: "propagation_failed",
        projectId,
        fields: changes.map((change) => change.fieldName),
        error: errorMessage(e),
      })}`,
    );
  }
}
