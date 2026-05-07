import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { CodingPage } from "@/components/coding/CodingPage";
import { getResearcherProgress } from "@/actions/progress";
import type {
  Document,
  Assignment,
  PydanticField,
  Round,
  RoundStrategy,
} from "@/lib/types";
import {
  classifyDocStatus,
  versionLabel,
  isCurrentFilter,
  type RoundContext,
  type ResponseRoundFields,
  type SchemaVersion,
} from "@/lib/rounds";

export default async function CodePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string; round?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const isImpersonating = !!(user.isMaster && sp.viewAsUser);
  const effectiveUserId = isImpersonating ? sp.viewAsUser! : user.id;
  const roundParam = sp.round ?? "current";

  const supabase = await createSupabaseServer();

  const [{ data: project }, { data: assignments }, { data: rounds }, progressResult] =
    await Promise.all([
      supabase
        .from("projects")
        .select(
          "pydantic_fields, round_strategy, current_round_id, schema_version_major, schema_version_minor, schema_version_patch",
        )
        .eq("id", id)
        .single(),
      supabase
        .from("assignments")
        .select("id, status, document_id, documents(id, external_id, title, text)")
        .eq("project_id", id)
        .eq("user_id", effectiveUserId)
        .eq("type", "codificacao")
        .order("status", { ascending: true }),
      supabase
        .from("rounds")
        .select("id, project_id, label, created_at")
        .eq("project_id", id)
        .order("created_at", { ascending: true }),
      getResearcherProgress(id, effectiveUserId).catch(() => null),
    ]);

  const allDocuments = (assignments || []).map((a) => ({
    ...(a.documents as unknown as Document),
    assignment: { id: a.id, status: a.status } as Pick<Assignment, "id" | "status">,
  }));

  // Responses incluem agora round_id e schema_version para classificacao por rodada
  const docIds = allDocuments.map((d) => d.id);
  const { data: responses } = await supabase
    .from("responses")
    .select(
      "document_id, answers, justifications, round_id, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("project_id", id)
    .eq("respondent_id", effectiveUserId)
    .in("document_id", docIds.length > 0 ? docIds : ["__none__"]);

  const responseByDoc = new Map<
    string,
    ResponseRoundFields & {
      answers: Record<string, unknown>;
      justifications: Record<string, unknown> | null;
    }
  >();
  responses?.forEach((r) => {
    responseByDoc.set(r.document_id, {
      answers: (r.answers as Record<string, unknown>) ?? {},
      justifications: (r.justifications as Record<string, unknown> | null) ?? null,
      round_id: r.round_id,
      schema_version_major: r.schema_version_major,
      schema_version_minor: r.schema_version_minor,
      schema_version_patch: r.schema_version_patch,
    });
  });

  const currentVersion: SchemaVersion = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };
  const strategy: RoundStrategy =
    (project?.round_strategy as RoundStrategy) ?? "schema_version";
  const ctx: RoundContext = {
    strategy,
    currentRoundId: project?.current_round_id ?? null,
    currentVersion,
    rounds: (rounds ?? []) as Round[],
  };
  const roundsById = new Map(ctx.rounds.map((r) => [r.id, r]));

  // Versoes anteriores presentes em responses (apenas estrategia schema_version)
  const previousVersions = Array.from(
    new Set(
      (responses ?? [])
        .map((r) => {
          const m = r.schema_version_major;
          const n = r.schema_version_minor;
          const p = r.schema_version_patch;
          if (m == null || n == null || p == null) return null;
          const v = versionLabel({ major: m, minor: n, patch: p });
          if (v === versionLabel(currentVersion)) return null;
          return v;
        })
        .filter((v): v is string => v != null),
    ),
  ).sort();

  // Filtro server-side conforme roundParam
  const filteredDocuments = allDocuments.filter((d) => {
    const resp = responseByDoc.get(d.id);
    const status = classifyDocStatus(ctx, resp ?? null, roundsById);

    if (roundParam === "all") return true;
    if (isCurrentFilter(roundParam)) {
      // Padrao: mostra docs que ainda precisam ser respondidos na rodada atual
      // (sem resposta OU resposta de rodada anterior). Concluidos da atual saem.
      return status.kind !== "current_done";
    }
    // Rodada especifica: id (manual) ou label (schema_version)
    if (strategy === "manual") {
      return resp?.round_id === roundParam;
    }
    return (
      status.kind === "previous" && status.label === roundParam
    );
  });

  const fields = ((project?.pydantic_fields || []) as PydanticField[]).filter(
    (f) => f.target !== "llm_only" && f.target !== "none",
  );
  const existingAnswers: Record<string, Record<string, unknown>> = {};
  const existingJustifications: Record<string, Record<string, unknown>> = {};
  for (const d of filteredDocuments) {
    const r = responseByDoc.get(d.id);
    if (!r) continue;
    const clean: Record<string, unknown> = {};
    for (const field of fields) {
      const val = r.answers[field.name];
      if (val === undefined || val === null) continue;
      if (field.type === "single" && field.options) {
        if (field.options.includes(val as string)) clean[field.name] = val;
      } else if (field.type === "multi" && field.options) {
        const arr = Array.isArray(val)
          ? val.filter((v: string) => field.options!.includes(v))
          : [];
        if (arr.length > 0) clean[field.name] = arr;
      } else {
        clean[field.name] = val;
      }
    }
    existingAnswers[d.id] = clean;
    if (r.justifications) {
      existingJustifications[d.id] = r.justifications;
    }
  }

  let progress = null;
  if (allDocuments.length > 0 && progressResult) {
    progress = {
      completed: progressResult.completed,
      total: progressResult.total,
      nextDeadline: progressResult.nextDeadline,
      daysUntilDeadline: progressResult.daysUntilDeadline,
      requiredPace: progressResult.requiredPace,
      streak: progressResult.streak,
    };
  }

  // Quando filtra por rodada anterior, painel fica readOnly para evitar
  // que pesquisador edite achando que ainda esta na rodada antiga.
  // (Salvar promove para a rodada atual de qualquer jeito.)
  const isViewingPreviousRound =
    !isCurrentFilter(roundParam) && roundParam !== "all";

  const currentRoundLabel =
    strategy === "manual"
      ? ctx.currentRoundId
        ? roundsById.get(ctx.currentRoundId)?.label ?? "Sem rodada atual"
        : "Sem rodada atual"
      : versionLabel(currentVersion);

  const currentRoundKey =
    strategy === "manual"
      ? ctx.currentRoundId ?? ""
      : versionLabel(currentVersion);

  return (
    <CodingPage
      projectId={id}
      documents={filteredDocuments}
      fields={fields}
      existingAnswers={existingAnswers}
      existingJustifications={existingJustifications}
      hasAssignments={allDocuments.length > 0}
      progress={progress}
      readOnly={isImpersonating || isViewingPreviousRound}
      roundFilter={{
        strategy,
        currentRoundKey,
        currentRoundLabel,
        rounds: ctx.rounds,
        previousVersions,
        selected: roundParam,
      }}
    />
  );
}
