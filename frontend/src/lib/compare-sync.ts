import "server-only";

import type { createSupabaseServer } from "@/lib/supabase/server";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import {
  computeDivergentFieldNames,
  isFreeTextField,
  resolveCompareStatus,
} from "@/lib/compare-divergence";
import {
  latestMajorAnchor,
  responseQualifiesForVersion,
  type SchemaVersion,
  type VersionedResponse,
} from "@/lib/compare-version";
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

  // Conclusão usa o MESMO predicado da página (`responseQualifiesForVersion`,
  // anti-drift #217) com o piso da RODADA CORRENTE — `latestMajorAnchor` da
  // versão atual do projeto, que é exatamente o filtro default `latest_major`
  // da UI. Esse é o conjunto canônico de "concluído": independe do filtro de
  // versão efêmero que a revisora escolha, e por ser a visão mais estreita
  // selecionável é sempre subconjunto do que ela vê em qualquer filtro — então
  // resolver tudo que aparece na tela sempre fecha o parecer. Isso descarta
  // tanto o pré-versionamento (pydantic_hash NULL) quanto rodadas antigas
  // (is_latest superseded ou versão < corrente), espelhando o que a tela mostra.
  const projectVersion: SchemaVersion = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };
  const minVersion = latestMajorAnchor(projectVersion);
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
