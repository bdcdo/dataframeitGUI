import "server-only";

import type { createSupabaseServer } from "@/lib/supabase/server";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import {
  computeDivergentFieldNames,
  isFreeTextField,
  resolveCompareStatus,
} from "@/lib/compare-divergence";
import {
  resolveMinVersion,
  responseQualifiesForVersion,
  type SchemaVersion,
  type VersionedResponse,
} from "@/lib/compare-version";
import { DEFAULT_COMPARE_FILTERS } from "@/lib/compare-filters";
import type { EquivalencePair } from "@/lib/equivalence";

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's "comparacao" assignment on this document, taking into account
// any equivalences registered between responses for free-text fields.
export async function syncCompareAssignment(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const { data: assignment } = await supabase
    .from("assignments")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .maybeSingle();

  if (!assignment) return;

  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: equivalences },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", projectId)
      .single(),
    supabase
      .from("responses")
      .select(
        "id, respondent_type, is_latest, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch, answers, answer_field_hashes",
      )
      .eq("project_id", projectId)
      .eq("document_id", documentId),
    supabase
      .from("reviews")
      .select("field_name")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("reviewer_id", userId),
    supabase
      .from("response_equivalences")
      .select("field_name, response_a_id, response_b_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId),
  ]);

  const reviewedFields = new Set((reviews ?? []).map((r) => r.field_name));

  const fields = (project?.pydantic_fields as PydanticField[]) || [];

  // Conclusão usa o MESMO predicado (`responseQualifiesForVersion`, anti-drift
  // #217) e o MESMO piso de versão que a página aplica no estado DEFAULT da UI
  // — derivado de `DEFAULT_COMPARE_FILTERS.version` via `resolveMinVersion`, a
  // mesma função que `compare/page.tsx` chama. Hoje o default é "all"
  // (compare-filters.ts), então `minVersion` é null (sem piso) e o fecho
  // considera toda resposta `is_latest`, de qualquer versão — exatamente o que
  // a revisora vê "sem filtro". Por construção, no estado default a visão e o
  // fecho coincidem: resolver as divergências visíveis sempre fecha o parecer.
  //
  // O que muda em relação ao sync antigo (`is_latest || respondent_type ===
  // "humano"`) é só a exclusão de codificações SUPERSEDED (`is_latest=false`,
  // humanas inclusive) — que o antigo contava e a tela não mostrava, a causa
  // real da trava do #217. Pré-versionamento (`pydantic_hash` NULL) e rodadas
  // antigas permanecem no fecho, espelhando o default `all`.
  //
  // Filtros efêmeros (versão manual, `since`, `respondent`) são lentes de
  // inspeção: NÃO redefinem "concluído". Se a revisora escolher uma lente mais
  // estreita que o default, a tela pode mostrar menos do que o fecho exige —
  // comportamento esperado de uma lente, fora do fluxo "sem filtro".
  const projectVersion: SchemaVersion = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };
  const minVersion = resolveMinVersion(
    DEFAULT_COMPARE_FILTERS.version,
    projectVersion,
  );
  const projectVersionCtx = {
    pydanticHash: project?.pydantic_hash ?? null,
    version: projectVersion,
  };

  type ActiveResponse = {
    id: string;
    answers: Record<string, unknown>;
    answerFieldHashes: AnswerFieldHashes;
  };
  const activeResponses: ActiveResponse[] = (responses ?? [])
    .filter((r) =>
      responseQualifiesForVersion(
        r as unknown as VersionedResponse,
        minVersion,
        projectVersionCtx,
      ),
    )
    .map((r) => ({
      id: r.id,
      answers: (r.answers ?? {}) as Record<string, unknown>,
      answerFieldHashes: r.answer_field_hashes as AnswerFieldHashes,
    }));

  const equivalencesByField = new Map<string, EquivalencePair[]>();
  for (const eq of equivalences ?? []) {
    if (!equivalencesByField.has(eq.field_name)) {
      equivalencesByField.set(eq.field_name, []);
    }
    equivalencesByField.get(eq.field_name)!.push({
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
    });
  }

  const divergentFields = computeDivergentFieldNames(
    fields,
    activeResponses,
    equivalencesByField,
  );

  // `resolveCompareStatus` trata o caso `divergentFields.length === 0` (ex.:
  // todas as divergências fundidas por equivalência): vira `concluido` em vez de
  // ficar preso. Atualiza só quando o status muda, limpando `completed_at` em
  // qualquer regressão (ex.: desmarcar uma equivalência reabre a divergência).
  const next = resolveCompareStatus(divergentFields, reviewedFields);
  if (assignment.status !== next) {
    await supabase
      .from("assignments")
      .update({
        status: next,
        completed_at: next === "concluido" ? new Date().toISOString() : null,
      })
      .eq("id", assignment.id);
  }
}

export { isFreeTextField };
