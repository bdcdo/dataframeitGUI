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
    expect(canEditPendingMemberEmail(null, false)).toBe(true);
    expect(canEditPendingMemberEmail(null, true)).toBe(false);
    expect(canEditPendingMemberEmail("2026-07-15T12:00:00Z", false)).toBe(
      false,
    );
    expect(canEditPendingMemberEmail(undefined, false)).toBe(false);
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
