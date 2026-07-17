import type { MemberEmailLink, ProjectMember, Profile } from "@/lib/types";

export type MemberRow = ProjectMember & {
  profiles: Profile | null;
  accessState: MemberAccessState;
  isClaimable: boolean;
};

export type MemberAccessState = "ready" | "pending" | "unavailable";

export type MemberEmailLinkView = MemberEmailLink & {
  accessReady: boolean;
};

export interface ClerkMappingAccessState {
  access_sync_version: number;
  clerk_deleted: boolean;
}

export type ClerkMappingAccessRow = ClerkMappingAccessState & {
  supabase_user_id: string;
};

export interface MemberActivationLink {
  member_user_id: string;
  accessReady: boolean;
}

export function clerkMappingAccessStatesByUserId(
  mappings: readonly ClerkMappingAccessRow[],
): Map<string, ClerkMappingAccessState> {
  return new Map(
    mappings.map((mapping) => [
      mapping.supabase_user_id,
      {
        access_sync_version: mapping.access_sync_version,
        clerk_deleted: mapping.clerk_deleted,
      },
    ]),
  );
}

function isClerkMappingAccessReady(
  mapping: ClerkMappingAccessState | undefined,
): boolean {
  if (!mapping) return false;
  return mapping.access_sync_version >= 1 && !mapping.clerk_deleted;
}

export function isMemberEmailLinkAccessReady(
  linkedUserId: string | null,
  profileActivatedAt: string | null | undefined,
  mapping: ClerkMappingAccessState | undefined,
): boolean {
  return (
    linkedUserId !== null &&
    profileActivatedAt != null &&
    isClerkMappingAccessReady(mapping)
  );
}

export function activeAliasMemberIds(
  links: readonly MemberActivationLink[],
): Set<string> {
  return new Set(
    links.filter((link) => link.accessReady).map((link) => link.member_user_id),
  );
}

export function projectMemberAccessState(
  memberUserId: string,
  profileActivatedAt: string | null | undefined,
  mapping: ClerkMappingAccessState | undefined,
  activeAliasIds: ReadonlySet<string>,
): MemberAccessState {
  if (activeAliasIds.has(memberUserId)) return "ready";
  if (profileActivatedAt != null && isClerkMappingAccessReady(mapping)) {
    return "ready";
  }
  if (profileActivatedAt === null && mapping === undefined) return "pending";
  return "unavailable";
}

export function canEditPendingMemberEmail(
  memberUserId: string,
  profileActivatedAt: string | null | undefined,
  hasClerkMapping: boolean,
  activeAliasIds: ReadonlySet<string>,
): boolean {
  // Membro "ready" via alias resolvido não é um placeholder reivindicável:
  // repontar o e-mail dele abriria a mesma identidade canônica para uma
  // segunda pessoa enquanto o alias continua resolvendo para a primeira.
  // Mesmo critério de projectMemberAccessState — os dois não podem divergir.
  return (
    profileActivatedAt === null &&
    !hasClerkMapping &&
    !activeAliasIds.has(memberUserId)
  );
}

export function memberDisplayName(m: MemberRow): string {
  return m.profiles?.first_name || m.profiles?.email || "Sem perfil";
}

export function groupLinksByMember(
  emailLinks: MemberEmailLinkView[],
): Map<string, MemberEmailLinkView[]> {
  const linksByMember = new Map<string, MemberEmailLinkView[]>();
  for (const link of emailLinks) {
    const list = linksByMember.get(link.member_user_id) ?? [];
    list.push(link);
    linksByMember.set(link.member_user_id, list);
  }
  return linksByMember;
}
