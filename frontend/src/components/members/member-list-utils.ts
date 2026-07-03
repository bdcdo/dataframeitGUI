import type { MemberEmailLink, ProjectMember, Profile } from "@/lib/types";

export type MemberRow = ProjectMember & { profiles: Profile | null };

export function memberDisplayName(m: MemberRow): string {
  return m.profiles?.first_name || m.profiles?.email || "Sem perfil";
}

export function groupLinksByMember(
  emailLinks: MemberEmailLink[]
): Map<string, MemberEmailLink[]> {
  const linksByMember = new Map<string, MemberEmailLink[]>();
  for (const link of emailLinks) {
    const list = linksByMember.get(link.member_user_id) ?? [];
    list.push(link);
    linksByMember.set(link.member_user_id, list);
  }
  return linksByMember;
}
