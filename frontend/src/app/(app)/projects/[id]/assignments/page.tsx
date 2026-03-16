import { createSupabaseServer } from "@/lib/supabase/server";
import { AssignmentTable } from "@/components/assignments/AssignmentTable";
import { LotteryDialog } from "@/components/assignments/LotteryDialog";
import { ClearPendingButton } from "@/components/assignments/ClearPendingButton";
import type { ProjectMember } from "@/lib/types";

export default async function AssignmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const [{ data: documents }, { data: researchers }, { data: assignments }, { data: coordinators }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("id, external_id, title")
        .eq("project_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("project_members")
        .select("*, profiles(*)")
        .eq("project_id", id)
        .eq("role", "pesquisador"),
      supabase
        .from("assignments")
        .select("*")
        .eq("project_id", id),
      supabase
        .from("project_members")
        .select("*, profiles(*)")
        .eq("project_id", id)
        .eq("role", "coordenador"),
    ]);

  type TypedMember = ProjectMember & {
    profiles: { first_name: string | null; email: string };
  };

  const typedResearchers = (researchers || []) as unknown as TypedMember[];
  const typedCoordinators = (coordinators || []) as unknown as TypedMember[];

  const allResearchersForTable = [...typedResearchers, ...typedCoordinators];

  const coordinatorOptions = typedCoordinators.map((c) => ({
    userId: c.user_id,
    name: c.profiles?.first_name || c.profiles?.email || c.user_id.slice(0, 8),
  }));

  const pendingCount = (assignments || []).filter((a) => a.status === "pendente").length;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Atribuições</h2>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <ClearPendingButton projectId={id} pendingCount={pendingCount} />
          )}
          <LotteryDialog
            projectId={id}
            totalDocs={(documents || []).length}
            totalResearchers={typedResearchers.length}
            coordinators={coordinatorOptions}
          />
        </div>
      </div>
      <AssignmentTable
        projectId={id}
        documents={documents || []}
        researchers={allResearchersForTable}
        assignments={assignments || []}
      />
    </div>
  );
}
