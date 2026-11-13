// Autocomparação em lote, pela linha de comando
// (`scripts/self-comparison/assign.ts`). Faz o mesmo que o coordenador faz
// clicando na tabela de atribuições e confirmando, para vários documentos de
// uma vez: cria a comparação, liberada pelo coordenador, de documentos que o
// próprio pesquisador codificou. Quem valida a liberação é o banco
// (guard_self_comparison_approval, 20261113120000): o aprovador precisa ser
// coordenador ou criador do projeto.

import { scanComparisonBacklog } from "@/lib/auto-comparison";
import type { ComparisonMode } from "@/lib/comparison-set";
import type { SupabaseServerClient } from "@/lib/supabase/server";

export type SelfComparisonSource = { kind: "backlog" } | { kind: "documents"; ids: string[] };

export interface SelfComparisonArgs {
  projectId: string;
  userId: string;
  approverId: string;
  source: SelfComparisonSource;
  dryRun: boolean;
}

export const SELF_COMPARISON_USAGE =
  "uso: npm run assign:self-comparison -- --project <id> --user <id> --approved-by <id> " +
  "(--backlog | --documents <id,id,...>) [--dry-run]";

const VALUE_FLAGS = ["--project", "--user", "--approved-by", "--documents"] as const;

/**
 * Lê os argumentos, ou `null` para uso inválido. Argumento desconhecido
 * invalida o uso, como no `resync:compare`: um `--dryrun` digitado errado não
 * pode virar gravação.
 */
export function parseSelfComparisonArgs(argv: readonly string[]): SelfComparisonArgs | null {
  const values = new Map<string, string>();
  let backlog = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--backlog") backlog = true;
    else if (arg === "--dry-run") dryRun = true;
    else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--") || values.has(arg)) return null;
      values.set(arg, value);
      i += 1;
    } else return null;
  }
  const projectId = values.get("--project");
  const userId = values.get("--user");
  const approverId = values.get("--approved-by");
  const documents = values.get("--documents");
  if (!projectId || !userId || !approverId || backlog === (documents !== undefined)) return null;
  const source: SelfComparisonSource = backlog
    ? { kind: "backlog" }
    : { kind: "documents", ids: documents!.split(",").map((id) => id.trim()).filter(Boolean) };
  if (source.kind === "documents" && source.ids.length === 0) return null;
  return { projectId, userId, approverId, source, dryRun };
}

export type SkipReason = "não codificou" | "comparação ativa" | "já tem comparação nesta rodada";

export interface SelfComparisonPlan {
  assign: string[];
  skipped: { documentId: string; reason: SkipReason }[];
}

/**
 * Quais documentos recebem a autocomparação. Fica de fora o documento que o
 * pesquisador não codificou (não seria autocomparação), o que já tem
 * comparação ativa (um revisor por documento) e o que já tem comparação dele
 * na rodada (a UNIQUE da rodada recusaria).
 */
export function planSelfComparisons(input: {
  documentIds: readonly string[];
  codedByUser: ReadonlySet<string>;
  activeComparison: ReadonlySet<string>;
  userComparisonThisRound: ReadonlySet<string>;
}): SelfComparisonPlan {
  const plan: SelfComparisonPlan = { assign: [], skipped: [] };
  for (const documentId of new Set(input.documentIds)) {
    const reason: SkipReason | null = !input.codedByUser.has(documentId)
      ? "não codificou"
      : input.activeComparison.has(documentId)
        ? "comparação ativa"
        : input.userComparisonThisRound.has(documentId)
          ? "já tem comparação nesta rodada"
          : null;
    if (reason) plan.skipped.push({ documentId, reason });
    else plan.assign.push(documentId);
  }
  return plan;
}

function rowsOrThrow<T>(label: string, result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data ?? [];
}

async function backlogDocumentsCodedBy(
  client: SupabaseServerClient,
  projectId: string,
  userId: string,
): Promise<string[]> {
  const { data: project, error } = await client
    .from("projects")
    .select("automation_mode")
    .eq("id", projectId)
    .single();
  if (error) throw new Error(`projects: ${error.message}`);
  const mode = project?.automation_mode;
  if (mode !== "compare_humans" && mode !== "compare_llm") {
    throw new Error(`o projeto está em '${mode}', sem backlog de comparação; use --documents`);
  }
  const backlog = await scanComparisonBacklog(client, projectId, mode as ComparisonMode);
  return backlog.filter((entry) => entry.coderIds.has(userId)).map((entry) => entry.documentId);
}

/** Planeja e, fora do `dryRun`, grava as autocomparações num único INSERT. */
export async function assignSelfComparisons(
  client: SupabaseServerClient,
  args: SelfComparisonArgs,
): Promise<SelfComparisonPlan> {
  const documentIds =
    args.source.kind === "backlog"
      ? await backlogDocumentsCodedBy(client, args.projectId, args.userId)
      : args.source.ids;
  if (documentIds.length === 0) return { assign: [], skipped: [] };

  const [projectResult, codedResult, comparisonsResult] = await Promise.all([
    client.from("projects").select("current_round_id").eq("id", args.projectId).single(),
    client
      .from("responses")
      .select("document_id")
      .eq("project_id", args.projectId)
      .eq("respondent_id", args.userId)
      .eq("respondent_type", "humano")
      .eq("is_latest", true)
      .in("document_id", documentIds),
    client
      .from("assignments")
      .select("document_id, user_id, status, round_id")
      .eq("project_id", args.projectId)
      .eq("type", "comparacao")
      .in("document_id", documentIds),
  ]);
  if (projectResult.error) throw new Error(`projects: ${projectResult.error.message}`);
  const roundId = projectResult.data?.current_round_id;
  const comparisons = rowsOrThrow("assignments", comparisonsResult);
  const plan = planSelfComparisons({
    documentIds,
    codedByUser: new Set(rowsOrThrow("responses", codedResult).map((r) => r.document_id)),
    activeComparison: new Set(comparisons.filter((c) => c.status !== "concluido").map((c) => c.document_id)),
    userComparisonThisRound: new Set(
      comparisons.filter((c) => c.user_id === args.userId && c.round_id === roundId).map((c) => c.document_id),
    ),
  });
  if (args.dryRun || plan.assign.length === 0) return plan;

  const { error } = await client.from("assignments").insert(
    plan.assign.map((documentId) => ({
      project_id: args.projectId,
      document_id: documentId,
      user_id: args.userId,
      type: "comparacao",
      status: "pendente",
      self_comparison_approved_by: args.approverId,
    })),
  );
  if (error) throw new Error(`assignments: ${error.message}`);
  return plan;
}
