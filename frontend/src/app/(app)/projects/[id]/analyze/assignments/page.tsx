import { unstable_cache } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { AssignmentTable } from "@/components/assignments/AssignmentTable";
import { LotteryDialog } from "@/components/assignments/LotteryDialog";
import { ClearPendingButton } from "@/components/assignments/ClearPendingButton";
import { AssignmentTypeToggle } from "@/components/assignments/AssignmentTypeToggle";
import type { ProjectMember } from "@/lib/types";

function getCachedDocuments(projectId: string) {
  return unstable_cache(
    async () => {
      const supabase = createSupabaseAdmin();
      const { data } = await supabase
        .from("documents")
        .select("id, external_id, title")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
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
      const { data } = await supabase
        .from("project_members")
        .select("user_id, role, project_id, profiles(first_name, email)")
        .eq("project_id", projectId)
        .eq("role", role);
      return data || [];
    },
    [`assignments-members-${projectId}-${role}`],
    { tags: [`project-${projectId}-members`], revalidate: 300 },
  )();
}

export default async function AssignmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const assignmentType = sp.type === "comparacao" ? "comparacao" as const : "codificacao" as const;
  const supabase = await createSupabaseServer();

  const [documents, researchers, { data: assignments }, coordinators] =
    await Promise.all([
      getCachedDocuments(id),
      getCachedMembers(id, "pesquisador"),
      supabase
        .from("assignments")
        .select("id, project_id, document_id, user_id, status, type, batch_id, deadline, completed_at")
        .eq("project_id", id)
        .eq("type", assignmentType),
      getCachedMembers(id, "coordenador"),
    ]);

  type TypedMember = ProjectMember & {
    profiles: { first_name: string | null; email: string };
  };

  const typedResearchers = (researchers || []) as unknown as TypedMember[];
  const typedCoordinators = (coordinators || []) as unknown as TypedMember[];

  const allResearchersForTable = [...typedResearchers, ...typedCoordinators];

  const coordinatorOptions = typedCoordinators.map((c) => ({
    userId: c.user_id,
    name:
      c.profiles?.first_name || c.profiles?.email || c.user_id.slice(0, 8),
  }));

  const assignedDocIds = new Set(
    (assignments || []).map((a) => a.document_id),
  );
  const sortedDocuments = [...(documents || [])].sort((a, b) => {
    const aHas = assignedDocIds.has(a.id) ? 0 : 1;
    const bHas = assignedDocIds.has(b.id) ? 0 : 1;
    return aHas - bHas;
  });

  const pendingCount = (assignments || []).filter(
    (a) => a.status === "pendente",
  ).length;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">Atribuições</h2>
          <AssignmentTypeToggle current={assignmentType} />
        </div>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <ClearPendingButton
              projectId={id}
              pendingCount={pendingCount}
              type={assignmentType}
            />
          )}
          <LotteryDialog
            projectId={id}
            totalDocs={(documents || []).length}
            totalResearchers={typedResearchers.length}
            coordinators={coordinatorOptions}
            type={assignmentType}
          />
        </div>
      </div>
      <AssignmentTable
        projectId={id}
        documents={sortedDocuments}
        researchers={allResearchersForTable}
        assignments={assignments || []}
        type={assignmentType}
      />
    </div>
  );
}
