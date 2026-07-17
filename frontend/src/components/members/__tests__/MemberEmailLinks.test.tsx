// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { MemberEmailLinks } from "@/components/members/MemberEmailLinks";
import type { MemberEmailLinkView } from "@/components/members/member-list-utils";

function link(accessReady: boolean): MemberEmailLinkView {
  return {
    id: accessReady ? "ready-link" : "pending-link",
    project_id: "project-1",
    member_user_id: "member-1",
    email: accessReady ? "ready@example.com" : "pending@example.com",
    linked_user_id: accessReady ? "ready-owner" : "pending-placeholder",
    created_by: "coordinator-1",
    created_at: "2026-07-15T12:00:00Z",
    accessReady,
  };
}

afterEach(cleanup);

describe("MemberEmailLinks", () => {
  it("distingue acesso pronto de UUID conhecido ainda pendente", () => {
    render(
      <MemberEmailLinks links={[link(true), link(false)]} onUnlink={vi.fn()} />,
    );

    expect(screen.getByText("↳ ready@example.com").parentElement?.title).toBe(
      "E-mail vinculado: a conta acessa o projeto como este membro.",
    );
    expect(screen.getByText("↳ pending@example.com").parentElement?.title).toBe(
      "E-mail vinculado aguardando a conclusão do acesso da conta.",
    );
    expect(screen.getByText("(acesso pendente)")).toBeTruthy();
  });
});
