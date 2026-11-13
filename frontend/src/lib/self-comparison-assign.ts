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

export type SkipReason =
  | "documento fora da base"
  | "não codificou"
  | "codificação em aberto na rodada"
  | "comparação ativa na rodada"
  | "já tem comparação nesta rodada";

export interface SelfComparisonPlan {
  assign: string[];
  skipped: { documentId: string; reason: SkipReason }[];
}

/**
 * Quais documentos recebem a autocomparação, na ordem das razões de recusa:
 * documento arquivado ou em revisão de escopo; documento sem codificação
 * entregue do pesquisador (rascunho não conta: não haveria o que comparar);
 * codificação dele ainda aberta na rodada (a tela também não oferece); outra
 * comparação ativa na rodada (um revisor por documento por rodada); e
 * comparação dele já existente na rodada (a UNIQUE da rodada recusaria).
 */
export function planSelfComparisons(input: {
  documentIds: readonly string[];
  inBase: ReadonlySet<string>;
  codedByUser: ReadonlySet<string>;
  openCodingThisRound: ReadonlySet<string>;
  activeComparisonThisRound: ReadonlySet<string>;
  userComparisonThisRound: ReadonlySet<string>;
}): SelfComparisonPlan {
  const checks: [ReadonlySet<string>, boolean, SkipReason][] = [
    [input.inBase, false, "documento fora da base"],
    [input.codedByUser, false, "não codificou"],
    [input.openCodingThisRound, true, "codificação em aberto na rodada"],
    [input.activeComparisonThisRound, true, "comparação ativa na rodada"],
    [input.userComparisonThisRound, true, "já tem comparação nesta rodada"],
  ];
  const plan: SelfComparisonPlan = { assign: [], skipped: [] };
  for (const documentId of new Set(input.documentIds)) {
    const failed = checks.find(([set, skipWhenPresent]) => set.has(documentId) === skipWhenPresent);
    if (failed) plan.skipped.push({ documentId, reason: failed[2] });
    else plan.assign.push(documentId);
  }
  return plan;
}

function rowsOrThrow<T>(label: string, result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data ?? [];
}

interface ProjectRow {
  automation_mode: string | null;
  current_round_id: string | null;
}

async function backlogDocumentsCodedBy(
  client: SupabaseServerClient,
  projectId: string,
  mode: string | null,
  userId: string,
): Promise<string[]> {
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
  const { data: project, error: projectError } = await client
    .from("projects")
    .select("automation_mode, current_round_id")
    .eq("id", args.projectId)
    .single<ProjectRow>();
  if (projectError) throw new Error(`projects: ${projectError.message}`);
  const roundId = project?.current_round_id;
  if (!roundId) throw new Error("O projeto não possui uma rodada atual.");
  const documentIds =
    args.source.kind === "backlog"
      ? await backlogDocumentsCodedBy(client, args.projectId, project.automation_mode, args.userId)
      : args.source.ids;
  if (documentIds.length === 0) return { assign: [], skipped: [] };

  const [documentsResult, codedResult, assignmentsResult] = await Promise.all([
    client
      .from("documents")
      .select("id")
      .eq("project_id", args.projectId)
      .is("excluded_at", null)
      .is("exclusion_pending_at", null)
      .in("id", documentIds),
    client
      .from("responses")
      .select("document_id")
      .eq("project_id", args.projectId)
      .eq("respondent_id", args.userId)
      .eq("respondent_type", "humano")
      .eq("is_latest", true)
      .eq("is_partial", false)
      .in("document_id", documentIds),
    client
      .from("assignments")
      .select("document_id, user_id, type, status")
      .eq("project_id", args.projectId)
      .eq("round_id", roundId)
      .in("type", ["codificacao", "comparacao"])
      .in("document_id", documentIds),
  ]);
  const assignments = rowsOrThrow("assignments", assignmentsResult);
  const ids = (rows: { document_id: string }[]) => new Set(rows.map((r) => r.document_id));
  const plan = planSelfComparisons({
    documentIds,
    inBase: new Set(rowsOrThrow("documents", documentsResult).map((d) => d.id)),
    codedByUser: ids(rowsOrThrow("responses", codedResult)),
    openCodingThisRound: ids(
      assignments.filter((a) => a.type === "codificacao" && a.user_id === args.userId && a.status !== "concluido"),
    ),
    activeComparisonThisRound: ids(assignments.filter((a) => a.type === "comparacao" && a.status !== "concluido")),
    userComparisonThisRound: ids(assignments.filter((a) => a.type === "comparacao" && a.user_id === args.userId)),
  });
  if (args.dryRun || plan.assign.length === 0) return plan;

  // Um INSERT só: o lote entra inteiro ou nada entra, e rodar de novo é seguro.
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
  if (error?.code === "23505") {
    throw new Error(
      "Outro revisor recebeu a comparação de algum destes documentos entre o plano e a gravação. Nada foi gravado; rode de novo.",
    );
  }
  if (error) throw new Error(`assignments: ${error.message}`);
  return plan;
}
