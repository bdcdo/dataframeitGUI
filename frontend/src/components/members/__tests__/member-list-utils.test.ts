import { describe, expect, it } from "vitest";

import {
  activeAliasMemberIds,
  canEditPendingMemberEmail,
  isMemberEmailLinkAccessReady,
  projectMemberAccessState,
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
