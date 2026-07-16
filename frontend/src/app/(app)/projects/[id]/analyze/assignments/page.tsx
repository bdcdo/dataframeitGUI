import { unstable_cache } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { notFound } from "next/navigation";
import { AssignmentTable } from "@/components/assignments/AssignmentTable";
import { LotteryDialog } from "@/components/assignments/LotteryDialog";
import { ClearPendingButton } from "@/components/assignments/ClearPendingButton";
import { membersTag } from "@/lib/cache";
import type { ProjectMember } from "@/lib/types";

function getCachedDocuments(projectId: string) {
  return unstable_cache(
    async () => {
      const supabase = createSupabaseAdmin();
      const { data, error } = await supabase
        .from("documents")
        .select("id, external_id, title")
        .eq("project_id", projectId)
        .is("excluded_at", null)
        .is("exclusion_pending_at", null)
        .order("created_at", { ascending: true });
      if (error) {
        console.error(
          `[assignments] getCachedDocuments falhou (projeto ${projectId}): ${error.message}`,
        );
      }
      return data || [];
    },
    [`assignments-docs-${projectId}`],
    { tags: [`project-${projectId}-documents`], revalidate: 300 },
  )();
}

function getCachedMembers(projectId: string, role: string) {
  return unstable_cache(
    async () => {
      const supabase = createSupabaseAdmin();
      const { data, error } = await supabase
        .from("project_members")
        .select(
          "user_id, role, project_id, assignment_weight, assignment_cap, profiles(first_name, email, activated_at)",
        )
        .eq("project_id", projectId)
        .eq("role", role);
      if (error) {
        console.error(
          `[assignments] getCachedMembers falhou (projeto ${projectId}, role ${role}): ${error.message}`,
        );
      }
      return data || [];
    },
    [`assignments-members-${projectId}-${role}`],
    { tags: [membersTag(projectId)], revalidate: 300 },
  )();
}

export default async function AssignmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user] = await Promise.all([params, getAuthUser()]);
  if (!user) notFound();

  // Os readers cacheados usam service role porque unstable_cache não pode
  // capturar um JWT individual. O layout pai pode renderizar em paralelo com a
  // page no App Router, então a autorização precisa existir neste entrypoint e
  // terminar antes de qualquer factory admin/cache reader ser chamado.
  const { project, queryFailed } = await getProjectAccessContext(
    id,
    user.id,
    user.isMaster,
  );
  if (queryFailed || !project) notFound();

  const supabase = await createSupabaseServer();

  const [documents, researchers, { data: assignments }, coordinators] =
    await Promise.all([
      getCachedDocuments(id),
      getCachedMembers(id, "pesquisador"),
      supabase
        .from("assignments")
        .select("id, project_id, document_id, user_id, status, type, batch_id, completed_at")
        .eq("project_id", id),
      getCachedMembers(id, "coordenador"),
    ]);

  type TypedMember = ProjectMember & {
    profiles: {
      first_name: string | null;
      email: string;
      activated_at: string | null;
    };
  };

  const typedResearchers = (researchers || []) as unknown as TypedMember[];
  const typedCoordinators = (coordinators || []) as unknown as TypedMember[];

  const allResearchersForTable = [...typedResearchers, ...typedCoordinators];

  const lotteryMembers = allResearchersForTable.map((m) => ({
    userId: m.user_id,
    name:
      m.profiles?.first_name || m.profiles?.email || m.user_id.slice(0, 8),
    role: m.role as "pesquisador" | "coordenador",
    pending: m.profiles?.activated_at === null,
    weight: m.assignment_weight ?? 1,
    cap: m.assignment_cap ?? null,
  }));

  const assignedDocIds = new Set(
    (assignments || []).map((a) => a.document_id),
  );
  const sortedDocuments = (documents || []).toSorted((a, b) => {
    const aHas = assignedDocIds.has(a.id) ? 0 : 1;
    const bHas = assignedDocIds.has(b.id) ? 0 : 1;
    return aHas - bHas;
  });

  const pendingByType = {
    codificacao: (assignments || []).filter(
      (a) => a.status === "pendente" && a.type === "codificacao",
    ).length,
    comparacao: (assignments || []).filter(
      (a) => a.status === "pendente" && a.type === "comparacao",
    ).length,
  };
  const hasPending = pendingByType.codificacao + pendingByType.comparacao > 0;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">Atribuições</h2>
          <span className="text-xs text-muted-foreground">
            Clique cicla: vazio → <span className="text-brand font-medium">C</span> codificação → <span className="text-amber-600 font-medium">R</span> comparação → vazio
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasPending && (
            <ClearPendingButton
              projectId={id}
              pendingByType={pendingByType}
            />
          )}
          <LotteryDialog projectId={id} members={lotteryMembers} />
        </div>
      </div>
      <AssignmentTable
        projectId={id}
        documents={sortedDocuments}
        researchers={allResearchersForTable}
        assignments={assignments || []}
      />
    </div>
  );
}
