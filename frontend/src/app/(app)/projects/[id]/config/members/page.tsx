import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { scanComparisonBacklog } from "@/lib/auto-comparison";
import { MemberList } from "@/components/members/MemberList";
import { AddMemberDialog } from "@/components/members/AddMemberDialog";
import type { MemberEmailLink, ProjectMember, Profile } from "@/lib/types";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import {
  activeAliasMemberIds,
  canEditPendingMemberEmail,
  clerkMappingAccessStatesByUserId,
  isMemberEmailLinkAccessReady,
  projectMemberAccessState,
  type ClerkMappingAccessState,
  type MemberEmailLinkView,
} from "@/components/members/member-list-utils";
import { notFound } from "next/navigation";

type AdminClient = ReturnType<typeof createSupabaseAdmin>;
type MemberQueryRow = ProjectMember & { profiles: Profile };
type EmailLinkQueryRow = MemberEmailLink & {
  linked_profile: Pick<Profile, "activated_at"> | null;
};

function isUserId(value: string | null): value is string {
  return value !== null;
}

async function loadClerkMappings(
  admin: AdminClient,
  members: readonly MemberQueryRow[],
  links: readonly EmailLinkQueryRow[],
): Promise<Map<string, ClerkMappingAccessState>> {
  const identityUserIds = [
    ...new Set([
      ...members.map((member) => member.user_id),
      ...links.map((link) => link.linked_user_id).filter(isUserId),
    ]),
  ];
  if (identityUserIds.length === 0) return new Map();

  const { data, error } = await admin
    .from("clerk_user_mapping")
    .select("supabase_user_id, access_sync_version, clerk_deleted")
    .in("supabase_user_id", identityUserIds);
  if (error) throw new Error(error.message);
  return clerkMappingAccessStatesByUserId(data);
}

function buildEmailLinkViews(
  links: readonly EmailLinkQueryRow[],
  mappings: Awaited<ReturnType<typeof loadClerkMappings>>,
): MemberEmailLinkView[] {
  return links.map(({ linked_profile: linkedProfile, ...link }) => ({
    ...link,
    accessReady: isMemberEmailLinkAccessReady(
      link.linked_user_id,
      linkedProfile?.activated_at,
      link.linked_user_id ? mappings.get(link.linked_user_id) : undefined,
    ),
  }));
}

function buildMemberRows(
  members: readonly MemberQueryRow[],
  links: readonly MemberEmailLinkView[],
  mappings: Awaited<ReturnType<typeof loadClerkMappings>>,
) {
  const activeAliasIds = activeAliasMemberIds(links);
  return members.map((member) => ({
    ...member,
    accessState: projectMemberAccessState(
      member.user_id,
      member.profiles.activated_at,
      mappings.get(member.user_id),
      activeAliasIds,
    ),
    isClaimable: canEditPendingMemberEmail(
      member.profiles.activated_at,
      mappings.has(member.user_id),
    ),
  }));
}

async function countOrphanedComparisons(
  admin: AdminClient,
  projectId: string,
  mode: string | null | undefined,
): Promise<number> {
  if (mode !== "compare_humans" && mode !== "compare_llm") return 0;
  // A comparação não materializa divergência. Esta página é coordinator-only e
  // de baixo tráfego, então a varredura sob demanda preserva uma fonte única.
  return (await scanComparisonBacklog(admin, projectId, mode)).length;
}

export default async function MembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  if (!access.isCoordinator) notFound();

  const [membersResult, reviewsResult, linksResult, projectResult] =
    await Promise.all([
      supabase
        .from("project_members")
        .select(
          "id, project_id, user_id, role, can_arbitrate, can_resolve, can_compare, profiles(id, email, first_name, last_name, activated_at)",
        )
        .eq("project_id", id),
      supabase
        .from("field_reviews")
        .select("id", { count: "exact", head: true })
        .eq("project_id", id)
        .eq("self_verdict", "contesta_llm")
        .is("arbitrator_id", null),
      supabase
        .from("member_email_links")
        .select(
          "id, project_id, member_user_id, email, linked_user_id, created_by, created_at, linked_profile:profiles!member_email_links_linked_user_id_fkey(activated_at)",
        )
        .eq("project_id", id),
      supabase.from("projects").select("automation_mode").eq("id", id).single(),
    ]);
  const pageError =
    membersResult.error ??
    reviewsResult.error ??
    linksResult.error ??
    projectResult.error;
  if (pageError) throw new Error(pageError.message);

  const members = (membersResult.data ?? []) as unknown as MemberQueryRow[];
  const orphanedReviews = reviewsResult.count;
  const emailLinks = (linksResult.data ?? []) as unknown as EmailLinkQueryRow[];
  const project = projectResult.data;
  const admin = createSupabaseAdmin();
  const [mappingsByUserId, orphanedComparisons] = await Promise.all([
    loadClerkMappings(admin, members, emailLinks),
    countOrphanedComparisons(admin, id, project?.automation_mode),
  ]);
  const emailLinkViews = buildEmailLinkViews(emailLinks, mappingsByUserId);
  const typedMembers = buildMemberRows(
    members,
    emailLinkViews,
    mappingsByUserId,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Membros</h2>
        <AddMemberDialog projectId={id} />
      </div>
      {orphanedReviews && orphanedReviews > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {orphanedReviews} caso(s) aguardando arbitragem sem árbitro elegível.
          Marque ao menos um membro como <strong>Arbitra</strong> abaixo para
          alocá-los.
        </div>
      ) : null}
      {orphanedComparisons > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {orphanedComparisons} documento(s) divergente(s) sem revisor de
          comparação. Marque ao menos um membro como <strong>Compara</strong>{" "}
          abaixo para alocá-los.
        </div>
      ) : null}
      <MemberList
        projectId={id}
        members={typedMembers}
        emailLinks={emailLinkViews}
        currentUserId={access.memberUserId}
      />
    </div>
  );
}
