import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext, type ProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { coordinatorGate } from "@/lib/project-access";
import { fetchProjectValueEquivalences } from "@/lib/value-equivalence-query";
import { loadReviewerNames } from "@/lib/reviews/reviewer-names";
import {
  buildEquivalenceFieldViews,
  buildEquivalenceHistoryViews,
  type EquivalenceHistoryRow,
  type EquivalenceRowWithMeta,
  type ViewerAuthority,
} from "@/lib/reviews/equivalences-view-model";
import { EquivalencesView } from "@/components/reviews/EquivalencesView";
import type { PydanticField } from "@/lib/types";

// Histórico é para consulta; as últimas bastam e mantêm a página leve.
const HISTORY_LIMIT = 200;

function rowsOrEmpty<T>(rows: unknown): T[] {
  return (rows ?? []) as T[];
}

// Fail-open só no papel: `canUndo` liga um botão, e a RPC
// remove_value_equivalence recheca dono e coordenação (fail-closed).
function viewerAuthority(access: ProjectAccessContext): ViewerAuthority {
  return {
    isCoordinator: coordinatorGate(access, { failOpen: true }),
    memberUserId: access.status === "resolved" ? access.memberUserId : null,
  };
}

export default async function EquivalencesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const [{ data: project }, equivalences, { data: history }, access] = await Promise.all([
    supabase.from("projects").select("pydantic_fields").eq("id", id).single(),
    fetchProjectValueEquivalences<EquivalenceRowWithMeta>(supabase, id, "source, created_at"),
    supabase
      .from("value_equivalence_history_entries")
      .select("id, field_name, value_a, value_b, reviewer_id, superseded_at, superseded_reason")
      .eq("project_id", id)
      .order("superseded_at", { ascending: false })
      .limit(HISTORY_LIMIT),
    getProjectAccessContext(id, user),
  ]);
  if (equivalences.error) throw new Error(equivalences.error.message);

  const historyRows = rowsOrEmpty<EquivalenceHistoryRow>(history);
  const nameOf = await loadReviewerNames(
    supabase,
    [...equivalences.data, ...historyRows].flatMap((row) => (row.reviewer_id ? [row.reviewer_id] : [])),
  );

  const fields = (project?.pydantic_fields ?? []) as PydanticField[];
  const viewer = viewerAuthority(access);

  return (
    <EquivalencesView
      projectId={id}
      fields={buildEquivalenceFieldViews(fields, equivalences.data, nameOf, viewer)}
      history={buildEquivalenceHistoryViews(fields, historyRows, nameOf)}
    />
  );
}
