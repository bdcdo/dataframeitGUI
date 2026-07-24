import { describe, expect, it } from "vitest";

import {
  activeAliasMemberIds,
  canEditPendingMemberEmail,
  isMemberEmailLinkAccessReady,
  memberDisplayName,
  memberSecondaryEmail,
  projectMemberAccessState,
  type MemberRow,
} from "@/components/members/member-list-utils";

describe("project member activation", () => {
  it("alias ativo torna o membro canônico ativo apenas no projeto do vínculo", () => {
    const activeAliases = activeAliasMemberIds([
      {
        member_user_id: "canonical-member",
        accessReady: true,
      },
      {
        member_user_id: "still-pending",
        accessReady: false,
      },
    ]);

    expect(
      projectMemberAccessState(
        "canonical-member",
        null,
        undefined,
        activeAliases,
      ),
    ).toBe("ready");
    expect(
      projectMemberAccessState("still-pending", null, undefined, activeAliases),
    ).toBe("pending");
  });

  it("profile canônico ativo exige mapping Clerk pronto", () => {
    expect(
      projectMemberAccessState(
        "direct-member",
        "2026-07-15T12:00:00Z",
        { access_sync_version: 1, clerk_deleted: false },
        new Set(),
      ),
    ).toBe("ready");
    expect(
      projectMemberAccessState(
        "revoked-member",
        "2026-07-15T12:00:00Z",
        { access_sync_version: 0, clerk_deleted: true },
        new Set(),
      ),
    ).toBe("unavailable");
    expect(
      projectMemberAccessState(
        "unmapped-active-member",
        "2026-07-15T12:00:00Z",
        undefined,
        new Set(),
      ),
    ).toBe("unavailable");
  });

  it("só permite editar placeholder pendente ainda sem mapping Clerk", () => {
    const none = new Set<string>();
    expect(canEditPendingMemberEmail("m1", null, false, none)).toBe(true);
    expect(canEditPendingMemberEmail("m1", null, true, none)).toBe(false);
    expect(
      canEditPendingMemberEmail("m1", "2026-07-15T12:00:00Z", false, none),
    ).toBe(false);
    expect(canEditPendingMemberEmail("m1", undefined, false, none)).toBe(false);
  });

  it("membro ready via alias resolvido não é reivindicável", () => {
    // Mesmo critério de projectMemberAccessState: alias ativo torna o membro
    // 'ready', então a affordance de trocar o e-mail do placeholder some.
    expect(
      canEditPendingMemberEmail("m1", null, false, new Set(["m1"])),
    ).toBe(false);
    expect(
      canEditPendingMemberEmail("m2", null, false, new Set(["m1"])),
    ).toBe(true);
  });

  it("só considera o vínculo pronto com profile ativo e mapping concluído", () => {
    const activeAt = "2026-07-15T12:00:00Z";
    expect(
      isMemberEmailLinkAccessReady("linked-user", activeAt, {
        access_sync_version: 1,
        clerk_deleted: false,
      }),
    ).toBe(true);
    expect(
      isMemberEmailLinkAccessReady("linked-user", null, {
        access_sync_version: 1,
        clerk_deleted: false,
      }),
    ).toBe(false);
    expect(
      isMemberEmailLinkAccessReady("linked-user", activeAt, {
        access_sync_version: 0,
        clerk_deleted: false,
      }),
    ).toBe(false);
    expect(
      isMemberEmailLinkAccessReady("linked-user", activeAt, {
        access_sync_version: 1,
        clerk_deleted: true,
      }),
    ).toBe(false);
    expect(isMemberEmailLinkAccessReady(null, activeAt, undefined)).toBe(false);
  });
});

describe("identificação do membro na confirmação de remoção", () => {
  function memberWithProfile(profile: MemberRow["profiles"]): MemberRow {
    return {
      id: "member-1",
      project_id: "project-1",
      user_id: "user-1",
      role: "pesquisador",
      can_arbitrate: false,
      can_resolve: false,
      can_compare: false,
      accessState: "ready",
      isClaimable: false,
      profiles: profile,
    };
  }

  const baseProfile = {
    id: "user-1",
    email: "ana@example.com",
    first_name: null,
    last_name: null,
    created_at: "2026-01-01T00:00:00Z",
    activated_at: "2026-01-02T00:00:00Z",
  };

  it("omite o e-mail quando ele já é o nome exibido", () => {
    const member = memberWithProfile(baseProfile);

    expect(memberDisplayName(member)).toBe("ana@example.com");
    expect(memberSecondaryEmail(member)).toBeNull();
  });

  it("mantém o e-mail quando ele desambigua o primeiro nome", () => {
    const member = memberWithProfile({ ...baseProfile, first_name: "Ana" });

    expect(memberDisplayName(member)).toBe("Ana");
    expect(memberSecondaryEmail(member)).toBe("ana@example.com");
  });

  it("não inventa e-mail para membro sem perfil", () => {
    const member = memberWithProfile(null);

    expect(memberDisplayName(member)).toBe("Sem perfil");
    expect(memberSecondaryEmail(member)).toBeNull();
  });
});
