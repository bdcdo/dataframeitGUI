import "server-only";

import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchFieldAnswers, fetchProjectValueEquivalences } from "@/lib/value-equivalence-query";
import { fetchFieldDefinition } from "@/lib/reviews/field-definition";
import { drainAutoReviewReconciliationRequests } from "@/lib/auto-review-reconciler";
import { resyncProjectCompareAssignments } from "@/lib/compare-assignment-sync";
import { affectedValueKeys, equivalenceValueKey, type ValueEquivalence } from "@/lib/equivalence";
import { errorMessage } from "@/lib/utils";

// O que muda fora do documento quando uma equivalência de valor nasce ou é
// desfeita. Ela vale no projeto inteiro, então a divergência muda em todo
// documento que tem um dos valores da classe: a fila da Comparação e a
// auto-revisão desses documentos precisam ser recalculadas.

type AdminClient = ReturnType<typeof createSupabaseAdmin>;

/** Uma equivalência criada ou desfeita: o campo e os valores dela. */
export interface ValueEquivalenceChange {
  fieldName: string;
  values: readonly unknown[];
  /**
   * A equivalência desfeita, que já não está na tabela: entra no cálculo da
   * classe, porque a classe ANTIGA é onde a divergência pode reaparecer.
   */
  removed?: ValueEquivalence;
}

/** Documentos em que alguma resposta vigente ao campo tem um dos valores. */
export async function documentsWithValues(
  admin: AdminClient,
  projectId: string,
  fieldName: string,
  valueKeys: ReadonlySet<string>,
): Promise<string[]> {
  if (valueKeys.size === 0) return [];
  const { data, error } = await fetchFieldAnswers(admin, projectId, fieldName);
  if (error) throw new Error(`responses: ${error.message}`);
  return [
    ...new Set(
      data
        .filter((row) => valueKeys.has(equivalenceValueKey(row.value)))
        .map((row) => row.document_id),
    ),
  ];
}

// Por campo, as chaves afetadas: os valores das mudanças e a classe de cada
// um, com as equivalências atuais mais as desfeitas.
async function affectedKeysByField(
  admin: AdminClient,
  projectId: string,
  changes: readonly ValueEquivalenceChange[],
): Promise<Map<string, Set<string>>> {
  const fieldNames = [...new Set(changes.map((change) => change.fieldName))];
  const [equivalences, ...fields] = await Promise.all([
    fetchProjectValueEquivalences(admin, projectId),
    ...fieldNames.map((fieldName) => fetchFieldDefinition(admin, projectId, fieldName)),
  ]);
  if (equivalences.error) throw new Error(`value_equivalences: ${equivalences.error.message}`);
  const removed = changes.flatMap((change) => (change.removed ? [change.removed] : []));
  const all = [...equivalences.data, ...removed];
  return new Map(
    fieldNames.map((fieldName, index) => [
      fieldName,
      affectedValueKeys(
        all,
        fields[index],
        changes.filter((change) => change.fieldName === fieldName).flatMap((change) => change.values),
      ),
    ]),
  );
}

/**
 * Pós-commit, fora do caminho da resposta ao clique: enfileira e drena UMA vez
 * a reconciliação da auto-revisão dos documentos afetados pelas mudanças e
 * ressincroniza as comparações só desses documentos. Admin client porque a
 * RLS de quem clicou não alcança os assignments de outros revisores nem a
 * fila de reconciliação; a autorização da mudança já foi provada pela RPC que
 * a gravou. Falha só é registrada: a equivalência já está gravada, e o
 * próximo save ou o reparo do coordenador recalculam.
 */
export async function propagateValueEquivalenceChange(input: {
  projectId: string;
  changes: readonly ValueEquivalenceChange[];
}): Promise<void> {
  const { projectId, changes } = input;
  const logFailure = (e: unknown) =>
    console.error(
      `[value-equivalence] ${JSON.stringify({
        event: "propagation_failed",
        projectId,
        fields: changes.map((change) => change.fieldName),
        error: errorMessage(e),
      })}`,
    );
  try {
    if (changes.length === 0) return;
    const admin = createSupabaseAdmin();
    const keysByField = await affectedKeysByField(admin, projectId, changes);
    const perField = await Promise.all(
      [...keysByField].map(([fieldName, keys]) => documentsWithValues(admin, projectId, fieldName, keys)),
    );
    const documentIds = [...new Set(perField.flat())];
    if (documentIds.length === 0) return;
    const { error } = await admin.rpc("enqueue_auto_review_reconciliation_for_documents", {
      p_project_id: projectId,
      p_document_ids: documentIds,
    });
    if (error) throw new Error(error.message);
    // Auto-revisão e comparação são independentes: as duas correm juntas, e a
    // falha de uma não esconde a outra.
    const results = await Promise.allSettled([
      drainAutoReviewReconciliationRequests({ projectId }),
      resyncProjectCompareAssignments(admin, projectId, { documentIds }),
    ]);
    for (const result of results) if (result.status === "rejected") logFailure(result.reason);
  } catch (e) {
    logFailure(e);
  }
}
