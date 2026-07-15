import { createSupabaseServer } from "@/lib/supabase/server";
import { getEffectiveMemberId } from "@/lib/auth";
import { scanComparisonBacklog } from "@/lib/auto-comparison";
import { MemberList } from "@/components/members/MemberList";
import { AddMemberDialog } from "@/components/members/AddMemberDialog";
import type { MemberEmailLink, ProjectMember, Profile } from "@/lib/types";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const projectContext = params.then(async ({ id }) => ({
    id,
    effectiveUserId: await getEffectiveMemberId(id),
  }));
  const [{ id, effectiveUserId }, supabase] = await Promise.all([
    projectContext,
    createSupabaseServer(),
  ]);

  const [
    { data: members },
    { count: orphanedReviews },
    { data: emailLinks },
    { data: project },
  ] = await Promise.all([
    supabase
      .from("project_members")
      .select("id, project_id, user_id, role, can_arbitrate, can_resolve, can_compare, profiles(id, email, first_name, last_name, activated_at)")
      .eq("project_id", id),
    supabase
      .from("field_reviews")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id)
      .eq("self_verdict", "contesta_llm")
      .is("arbitrator_id", null),
    supabase
      .from("member_email_links")
      .select("id, project_id, member_user_id, email, linked_user_id, created_by, created_at")
      .eq("project_id", id),
    supabase
      .from("projects")
      .select("automation_mode")
      .eq("id", id)
      .single(),
  ]);

  // Backlog de comparação sem revisor — só relevante nos modos de comparação.
  // Recomputado por varredura (a comparação não materializa divergência). Página
  // coordinator-only e de baixo tráfego, então a varredura aqui é aceitável.
  const mode = project?.automation_mode;
  let orphanedComparisons = 0;
  if (mode === "compare_humans" || mode === "compare_llm") {
    orphanedComparisons = (await scanComparisonBacklog(supabase, id, mode)).length;
  }

  const typedMembers = (members || []) as unknown as (ProjectMember & { profiles: Profile })[];

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Membros</h2>
        <AddMemberDialog projectId={id} />
      </div>
      {orphanedReviews && orphanedReviews > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {orphanedReviews} caso(s) aguardando arbitragem sem árbitro elegível. Marque ao menos um membro como <strong>Arbitra</strong> abaixo para alocá-los.
        </div>
      ) : null}
      {orphanedComparisons > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {orphanedComparisons} documento(s) divergente(s) sem revisor de comparação. Marque ao menos um membro como <strong>Compara</strong> abaixo para alocá-los.
        </div>
      ) : null}
      <MemberList
        projectId={id}
        members={typedMembers}
        emailLinks={(emailLinks || []) as MemberEmailLink[]}
        effectiveUserId={effectiveUserId}
      />
    </div>
  );
}
