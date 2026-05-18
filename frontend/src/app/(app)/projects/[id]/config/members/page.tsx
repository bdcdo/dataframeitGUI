import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { MemberList } from "@/components/members/MemberList";
import { AddMemberDialog } from "@/components/members/AddMemberDialog";
import type { ProjectMember, Profile } from "@/lib/types";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    getAuthUser(),
    createSupabaseServer(),
  ]);

  const [{ data: members }, { count: orphanedReviews }] = await Promise.all([
    supabase
      .from("project_members")
      .select("id, project_id, user_id, role, can_arbitrate, profiles(id, email, first_name, last_name)")
      .eq("project_id", id),
    supabase
      .from("field_reviews")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id)
      .eq("self_verdict", "contesta_llm")
      .is("arbitrator_id", null),
  ]);

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
      <MemberList
        projectId={id}
        members={typedMembers}
        currentUserId={user!.id}
      />
    </div>
  );
}
