import { createSupabaseServer } from "@/lib/supabase/server";
import { MemberList } from "@/components/members/MemberList";
import { AddMemberDialog } from "@/components/members/AddMemberDialog";
import type { ProjectMember, Profile } from "@/lib/types";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: members } = await supabase
    .from("project_members")
    .select("*, profiles(*)")
    .eq("project_id", id);

  const typedMembers = (members || []) as unknown as (ProjectMember & { profiles: Profile })[];

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Membros</h2>
        <AddMemberDialog projectId={id} />
      </div>
      <MemberList
        projectId={id}
        members={typedMembers}
        currentUserId={user!.id}
      />
    </div>
  );
}
