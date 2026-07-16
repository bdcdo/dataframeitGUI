import "server-only";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/utils";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { resolveCompareStatus } from "@/lib/compare-assignment-status";
import {
  responseQualifiesForVersion,
  versionGate,
  type VersionedResponse,
} from "@/lib/compare-version";
import type { EquivalencePair } from "@/lib/equivalence";

async function loadCompareSyncState(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const { data: assignment, error: assignmentError } = await supabase
    .from("assignments")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .maybeSingle();
  if (assignmentError) throw new Error(assignmentError.message);
  if (!assignment) return null;

  const results = await Promise.all([
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
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(failed.error.message);
  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: equivalences },
  ] = results;
  return { assignment, project, responses, reviews, equivalences };
}

type ActiveResponse = {
  id: string;
  answers: Record<string, unknown>;
  answerFieldHashes: AnswerFieldHashes;
};

// O fecho usa o mesmo piso `latest_major` da fila default. Codificações de
// majors anteriores, pré-versionamento e superseded não podem manter um
// assignment aberto por divergências que a revisora não vê (#217/#247/#286).
function qualifiedResponses(
  project: Record<string, unknown> | null,
  responses: Array<Record<string, unknown>>,
): ActiveResponse[] {
  const { minVersion, ctx: projectVersionCtx } = versionGate(project ?? {});
  return responses
    .filter((r) =>
      responseQualifiesForVersion(
        r as unknown as VersionedResponse,
        minVersion,
        projectVersionCtx,
      ),
    )
    .map((r) => ({
      id: r.id as string,
      answers: (r.answers ?? {}) as Record<string, unknown>,
      answerFieldHashes: r.answer_field_hashes as AnswerFieldHashes,
    }));
}

function groupEquivalences(
  equivalences: Array<{
    field_name: string;
    response_a_id: string;
    response_b_id: string;
  }>,
): Map<string, EquivalencePair[]> {
  const equivalencesByField = new Map<string, EquivalencePair[]>();
  for (const eq of equivalences) {
    if (!equivalencesByField.has(eq.field_name)) {
      equivalencesByField.set(eq.field_name, []);
    }
    equivalencesByField.get(eq.field_name)!.push({
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
    });
  }
  return equivalencesByField;
}

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's comparison assignment, including free-text equivalences.
function deriveCompareStatus(
  state: NonNullable<Awaited<ReturnType<typeof loadCompareSyncState>>>,
) {
  const { project, responses, reviews, equivalences } = state;
  const activeResponses = qualifiedResponses(
    project as Record<string, unknown> | null,
    (responses ?? []) as Array<Record<string, unknown>>,
  );
  // Sem um par qualificado, divergência vazia não significa revisão concluída.
  if (activeResponses.length < 2) return null;

  const fields = (project?.pydantic_fields as PydanticField[]) || [];
  const reviewedFields = new Set((reviews ?? []).map((r) => r.field_name));

  return resolveCompareStatus(
    computeDivergentFieldNames(
      fields,
      activeResponses,
      groupEquivalences(equivalences ?? []),
    ),
    reviewedFields,
  );
}

async function persistCompareStatus(
  supabase: SupabaseServerClient,
  assignment: { id: string; status: string },
  next: string,
) {
  // `resolveCompareStatus` trata o caso `divergentFields.length === 0` (ex.:
  // todas as divergências fundidas por equivalência): vira `concluido` em vez de
  // ficar preso. Atualiza só quando o status muda, limpando `completed_at` em
  // qualquer regressão (ex.: desmarcar uma equivalência reabre a divergência).
  if (assignment.status === next) return;
  const { error } = await supabase
    .from("assignments")
    .update({
      status: next,
      completed_at: next === "concluido" ? new Date().toISOString() : null,
    })
    .eq("id", assignment.id);
  if (error) throw new Error(error.message);
}

async function syncCompareAssignment(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const state = await loadCompareSyncState(
    supabase,
    projectId,
    documentId,
    userId,
  );
  if (!state) return;

  const next = deriveCompareStatus(state);
  if (next) await persistCompareStatus(supabase, state.assignment, next);
}

function revalidateComparePaths(
  projectId: string,
  options: { comments?: boolean; llmInsights?: boolean },
): void {
  if (options.comments) {
    revalidatePath(`/projects/${projectId}/reviews/comments`);
  }
  if (options.llmInsights) {
    revalidatePath(`/projects/${projectId}/reviews/llm-insights`);
  }
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}

export function scheduleCompareRevalidation(
  projectId: string,
  operation: string,
  options: { comments?: boolean; llmInsights?: boolean } = {},
): void {
  after(() => {
    try {
      revalidateComparePaths(projectId, options);
    } catch (error) {
      console.error(
        `[${operation}] falha ao revalidar após o commit: ${errorMessage(error)}`,
      );
    }
  });
}

export function finalizeCompareWrite({
  supabase,
  projectId,
  documentId,
  userId,
  operation,
  revalidateComments = false,
}: {
  supabase: SupabaseServerClient;
  projectId: string;
  documentId: string;
  userId: string;
  operation: string;
  revalidateComments?: boolean;
}): void {
  after(async () => {
    try {
      await syncCompareAssignment(supabase, projectId, documentId, userId);
    } catch (error) {
      console.error(
        `[${operation}] falha ao sincronizar o assignment pós-commit: ${errorMessage(error)}`,
      );
    }
    try {
      revalidateComparePaths(projectId, { comments: revalidateComments });
    } catch (error) {
      console.error(
        `[${operation}] falha ao revalidar após o commit: ${errorMessage(error)}`,
      );
    }
  });
}
