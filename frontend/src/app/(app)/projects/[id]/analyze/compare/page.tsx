import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ComparePage } from "@/components/compare/ComparePage";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import type { EquivalencePair } from "@/lib/equivalence";
import {
  readCompareFilters,
  type CompareFiltersValue,
} from "@/lib/compare-filters";
import type { PydanticField } from "@/lib/types";

interface CompareDoc {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

interface CompareResponse {
  id: string;
  document_id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  respondent_id: string | null;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  is_current: boolean;
  pydantic_hash: string | null;
  answer_field_hashes: Record<string, string> | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  created_at: string;
}

export interface DocCoverage {
  docId: string;
  humanCount: number; // responderam com versão ok
  totalCount: number;
  assignedCodingCount: number; // pesquisadores atribuídos em codificação
  humansFromAssigned: number; // dos atribuídos, quantos responderam
  divergentCount: number;
  reviewedCount: number;
  assignmentStatus: "pendente" | "em_andamento" | "concluido" | null;
}

// Compara (a.b.c) >= (d.e.f)
function versionGte(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

function parseVersionStr(
  s: string,
): { major: number; minor: number; patch: number } | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
  };
}

function resolveMinVersion(
  filter: CompareFiltersValue["version"],
  projectCurrent: { major: number; minor: number; patch: number },
): { major: number; minor: number; patch: number } | null {
  if (filter === "all") return null;
  if (filter === "latest_major") {
    return { major: projectCurrent.major, minor: 0, patch: 0 };
  }
  return parseVersionStr(filter);
}

export default async function ComparePageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const filters = readCompareFilters(sp);

  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

  const [
    { data: project },
    { data: membership },
    { data: allResponses, error: responsesError },
    { data: versionLog },
    { data: allAssignments },
    { data: allEquivalences },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_hash, pydantic_fields, min_responses_for_comparison, created_by, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("project_members")
      .select("role")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("responses")
      .select(
        "id, document_id, respondent_type, respondent_name, respondent_id, answers, justifications, is_current, pydantic_hash, answer_field_hashes, schema_version_major, schema_version_minor, schema_version_patch, created_at, documents(id, title, external_id)",
      )
      .eq("project_id", id)
      .limit(5000),
    supabase
      .from("schema_change_log")
      .select("version_major, version_minor, version_patch")
      .eq("project_id", id)
      .not("version_major", "is", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("assignments")
      .select("document_id, user_id, type, status")
      .eq("project_id", id),
    supabase
      .from("response_equivalences")
      // Project-scoped fetch (RLS filters anyway). For very large projects
      // it might be worth gating by `qualifiedDocIds` in a 2-phase fetch,
      // but volume should stay low — pairs are only created on free-text
      // divergences. Revisit if it becomes a bottleneck.
      .select("id, document_id, field_name, response_a_id, response_b_id, reviewer_id")
      .eq("project_id", id),
  ]);

  // Build (docId, fieldName) -> EquivalencePair[] map. Used both for divergence
  // detection on the server and for fusing answer cards on the client.
  const equivByDocField = new Map<
    string,
    Map<string, Array<EquivalencePair & { id: string; reviewer_id: string | null }>>
  >();
  for (const eq of allEquivalences ?? []) {
    if (!equivByDocField.has(eq.document_id)) {
      equivByDocField.set(eq.document_id, new Map());
    }
    const fieldMap = equivByDocField.get(eq.document_id)!;
    if (!fieldMap.has(eq.field_name)) fieldMap.set(eq.field_name, []);
    fieldMap.get(eq.field_name)!.push({
      id: eq.id,
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
      reviewer_id: eq.reviewer_id ?? null,
    });
  }

  const isCoordinator =
    membership?.role === "coordenador" || project?.created_by === user.id || user.isMaster;

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  if (responsesError) {
    console.error("Failed to fetch responses for compare:", responsesError.message);
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Erro ao carregar respostas. Tente novamente.
      </div>
    );
  }

  const projectVersion = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };
  const minVersion = resolveMinVersion(filters.version, projectVersion);
  const sinceMs = filters.since ? new Date(filters.since).getTime() : null;

  // Build distinct ordered version list desc — une versões do schema_change_log
  // com as efetivamente gravadas em responses (cobre respostas cuja versão
  // veio do backfill por hashes/created_at e não tem entry classificada no log).
  const versionSet = new Set<string>();
  for (const v of versionLog ?? []) {
    if (v.version_major !== null && v.version_minor !== null && v.version_patch !== null) {
      versionSet.add(`${v.version_major}.${v.version_minor}.${v.version_patch}`);
    }
  }
  for (const r of allResponses ?? []) {
    if (
      r.schema_version_major !== null &&
      r.schema_version_minor !== null &&
      r.schema_version_patch !== null
    ) {
      versionSet.add(
        `${r.schema_version_major}.${r.schema_version_minor}.${r.schema_version_patch}`,
      );
    }
  }
  const availableVersions = [...versionSet].sort((a, b) => {
    const pa = parseVersionStr(a)!;
    const pb = parseVersionStr(b)!;
    if (pa.major !== pb.major) return pb.major - pa.major;
    if (pa.minor !== pb.minor) return pb.minor - pa.minor;
    return pb.patch - pa.patch;
  });
  const latestMajorLabel = `${projectVersion.major}.0.0`;

  // Compare-type assignments filter for researchers
  let compareAssignedDocIds: Set<string> | null = null;
  if (!isCoordinator) {
    compareAssignedDocIds = new Set(
      (allAssignments ?? [])
        .filter((a) => a.type === "comparacao" && a.user_id === user.id)
        .map((a) => a.document_id),
    );
  }

  // Coding-type assignments map per doc (denominator for % atribuídos)
  const codingAssignedByDoc = new Map<string, Set<string>>();
  for (const a of allAssignments ?? []) {
    if (a.type !== "codificacao") continue;
    if (!codingAssignedByDoc.has(a.document_id)) {
      codingAssignedByDoc.set(a.document_id, new Set());
    }
    codingAssignedByDoc.get(a.document_id)!.add(a.user_id);
  }

  // Status per user-doc for compare assignment (used in list and panel)
  const compareAssignmentStatusByDoc = new Map<
    string,
    "pendente" | "em_andamento" | "concluido"
  >();
  if (!isCoordinator) {
    for (const a of allAssignments ?? []) {
      if (a.type !== "comparacao" || a.user_id !== user.id) continue;
      compareAssignmentStatusByDoc.set(
        a.document_id,
        a.status as "pendente" | "em_andamento" | "concluido",
      );
    }
  }

  const responsesByDoc = new Map<string, CompareResponse[]>();
  const docsMetaMap = new Map<string, Omit<CompareDoc, "text">>();

  allResponses?.forEach((r) => {
    const docId = r.document_id;
    if (!responsesByDoc.has(docId)) responsesByDoc.set(docId, []);
    responsesByDoc.get(docId)!.push(r as unknown as CompareResponse);
    if (r.documents) docsMetaMap.set(docId, r.documents as unknown as Omit<CompareDoc, "text">);
  });

  // Respondent names list (do conjunto todo, antes de filtrar)
  const respondentNames = [
    ...new Set(
      allResponses?.map((r) => r.respondent_name).filter(Boolean) ?? [],
    ),
  ] as string[];

  const qualifiedDocIds: string[] = [];
  const divergentFields: Record<string, string[]> = {};
  const responsesMap: Record<string, CompareResponse[]> = {};
  const coverageByDoc: Record<string, DocCoverage> = {};

  for (const [docId, docResponses] of responsesByDoc) {
    if (compareAssignedDocIds && !compareAssignedDocIds.has(docId)) continue;
    if (!docsMetaMap.has(docId)) continue;

    // Apply version + since + respondent filters per response
    const qualifiedResponses = docResponses.filter((r) => {
      // Keep only active (is_current) OR human responses — antigos (is_current=false) do LLM ficam fora
      if (!r.is_current && r.respondent_type !== "humano") return false;

      // Respostas pré-versionamento (pydantic_hash NULL) foram gravadas antes
      // da migration 20260420 que introduziu schema_version_*. Elas têm
      // `rv = {0,0,0}` via os `?? 0` abaixo e por isso passam o filtro
      // latest_major, reaparecendo como "divergências" mesmo quando a versão
      // atual tem consenso. Quando há filtro de versão ativo, descartamos.
      if (minVersion && r.pydantic_hash === null) return false;

      if (minVersion) {
        const rv = {
          major: r.schema_version_major ?? 0,
          minor: r.schema_version_minor ?? 0,
          patch: r.schema_version_patch ?? 0,
        };
        if (!versionGte(rv, minVersion)) return false;
      }
      if (sinceMs !== null) {
        if (new Date(r.created_at).getTime() < sinceMs) return false;
      }
      if (filters.respondent !== "all" && r.respondent_name !== filters.respondent) {
        return false;
      }
      return true;
    });

    const humanCount = qualifiedResponses.filter((r) => r.respondent_type === "humano").length;
    const totalCount = qualifiedResponses.length;

    const assignedUsers = codingAssignedByDoc.get(docId) ?? new Set<string>();
    const assignedCodingCount = assignedUsers.size;

    const humansFromAssigned = qualifiedResponses.filter(
      (r) => r.respondent_type === "humano" && r.respondent_id && assignedUsers.has(r.respondent_id),
    ).length;

    const pct = assignedCodingCount === 0 ? 100 : Math.round((humansFromAssigned / assignedCodingCount) * 100);

    // Apply coverage filters
    if (humanCount < filters.minHumans) continue;
    if (totalCount < filters.minTotal) continue;
    if (assignedCodingCount > 0 && pct < filters.minAssignedPct) continue;

    // Equivalence-aware divergence detection (free-text fields can have
    // responses fused via the reviewer's "marcar como equivalentes" action).
    const divergent = computeDivergentFieldNames(
      fields,
      qualifiedResponses,
      equivByDocField.get(docId),
    );

    if (divergent.length === 0) continue;

    qualifiedDocIds.push(docId);
    divergentFields[docId] = divergent;
    responsesMap[docId] = qualifiedResponses;
    coverageByDoc[docId] = {
      docId,
      humanCount,
      totalCount,
      assignedCodingCount,
      humansFromAssigned,
      divergentCount: divergent.length,
      reviewedCount: 0, // preenchido abaixo
      assignmentStatus: compareAssignmentStatusByDoc.get(docId) ?? null,
    };
  }

  // Fetch text + reviews + comment counts
  const [{ data: docTexts }, { data: reviews }, { data: commentCounts }, { data: suggestionCounts }] =
    await Promise.all([
      qualifiedDocIds.length > 0
        ? supabase
            .from("documents")
            .select("id, text")
            .in("id", qualifiedDocIds)
            .is("excluded_at", null)
        : Promise.resolve({ data: [] as { id: string; text: string }[] }),
      supabase
        .from("reviews")
        .select("document_id, field_name, verdict, chosen_response_id, comment, reviewer_id")
        .eq("project_id", id),
      supabase
        .from("project_comments")
        .select("document_id, field_name")
        .eq("project_id", id)
        .is("resolved_at", null),
      supabase
        .from("schema_suggestions")
        .select("field_name")
        .eq("project_id", id)
        .eq("status", "pending"),
    ]);

  const textMap = new Map((docTexts || []).map((d) => [d.id, d.text]));

  const documentsForCompare: CompareDoc[] = qualifiedDocIds.map((docId) => {
    const meta = docsMetaMap.get(docId)!;
    return { ...meta, text: textMap.get(docId) || "" };
  });

  const existingReviews: Record<
    string,
    Record<string, { verdict: string; chosenResponseId: string | null; comment: string | null }>
  > = {};

  // Track reviews do user atual para preencher reviewedCount
  const myReviewsByDoc = new Map<string, Set<string>>();
  reviews?.forEach((r) => {
    if (!existingReviews[r.document_id]) existingReviews[r.document_id] = {};
    // Sempre captura o veredito mais recente (se múltiplos reviewers, o da página é do user logado)
    existingReviews[r.document_id][r.field_name] = {
      verdict: r.verdict,
      chosenResponseId: r.chosen_response_id ?? null,
      comment: r.comment ?? null,
    };
    if (r.reviewer_id === user.id) {
      if (!myReviewsByDoc.has(r.document_id)) myReviewsByDoc.set(r.document_id, new Set());
      myReviewsByDoc.get(r.document_id)!.add(r.field_name);
    }
  });

  for (const docId of qualifiedDocIds) {
    const reviewed = myReviewsByDoc.get(docId) ?? new Set<string>();
    const divergent = divergentFields[docId] ?? [];
    coverageByDoc[docId].reviewedCount = divergent.filter((fn) => reviewed.has(fn)).length;
  }

  // Build comment+suggestion counts by (doc, field)
  const commentCountsByKey: Record<string, number> = {};
  for (const c of commentCounts ?? []) {
    const key = `${c.document_id ?? ""}|${c.field_name ?? ""}`;
    commentCountsByKey[key] = (commentCountsByKey[key] ?? 0) + 1;
  }
  const suggestionCountsByField: Record<string, number> = {};
  for (const s of suggestionCounts ?? []) {
    suggestionCountsByField[s.field_name] = (suggestionCountsByField[s.field_name] ?? 0) + 1;
  }

  // Sort docs: most unreviewed divergences first
  documentsForCompare.sort((a, b) => {
    const ca = coverageByDoc[a.id];
    const cb = coverageByDoc[b.id];
    const pendA = ca.divergentCount - ca.reviewedCount;
    const pendB = cb.divergentCount - cb.reviewedCount;
    return pendB - pendA;
  });

  // Serialize equivalences for the client component (Maps don't cross the
  // RSC boundary). Only ship pairs for documents in the qualified list.
  const equivalencesByDocField: Record<
    string,
    Record<
      string,
      Array<{
        id: string;
        response_a_id: string;
        response_b_id: string;
        reviewer_id: string | null;
      }>
    >
  > = {};
  for (const docId of qualifiedDocIds) {
    const fieldMap = equivByDocField.get(docId);
    if (!fieldMap) continue;
    equivalencesByDocField[docId] = {};
    for (const [fieldName, pairs] of fieldMap) {
      equivalencesByDocField[docId][fieldName] = pairs;
    }
  }

  return (
    <ComparePage
      projectId={id}
      documents={documentsForCompare}
      responses={responsesMap}
      divergentFields={divergentFields}
      fields={fields}
      existingReviews={existingReviews}
      projectPydanticHash={project?.pydantic_hash ?? null}
      respondentNames={respondentNames}
      coverageByDoc={coverageByDoc}
      commentCountsByKey={commentCountsByKey}
      suggestionCountsByField={suggestionCountsByField}
      availableVersions={availableVersions}
      latestMajorLabel={latestMajorLabel}
      currentProjectVersion={`${projectVersion.major}.${projectVersion.minor}.${projectVersion.patch}`}
      equivalencesByDocField={equivalencesByDocField}
      currentUserId={user.id}
      canManageAnyPair={isCoordinator}
    />
  );
}
