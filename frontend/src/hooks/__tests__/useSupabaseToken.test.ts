// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  LINKED_CLAIMS,
  UNLINKED_CLAIMS,
  sessionTokenWith,
} from "@/test-utils/session-token";

const clerk = vi.hoisted(() => ({
  getToken: vi.fn(),
  user: null as { publicMetadata: { supabase_uid?: string } } | null,
}));
vi.mock("@clerk/nextjs", () => ({
  // Objeto e função novos a cada render, como o pior caso do Clerk.
  useAuth: () => ({ getToken: (...args: unknown[]) => clerk.getToken(...args) }),
  useUser: () => ({ user: clerk.user }),
}));

import { useSupabaseToken } from "../useSupabaseToken";

describe("useSupabaseToken", () => {
  it("devolve a MESMA função entre renders", () => {
    // `useLlmRunProgress` a tem nas dependências do effect de polling: uma
    // identidade nova por render religaria o polling e sobreporia os ticks.
    const { result, rerender } = renderHook(() => useSupabaseToken());
    const first = result.current;
    clerk.user = { publicMetadata: { supabase_uid: LINKED_CLAIMS.supabase_uid } };
    rerender();
    expect(result.current).toBe(first);
  });

  it("a função estável lê a conta do render mais recente", async () => {
    const unlinked = sessionTokenWith({ ...UNLINKED_CLAIMS, jti: "hook" });
    clerk.getToken.mockResolvedValue(unlinked);
    clerk.user = null;
    const { result, rerender } = renderHook(() => useSupabaseToken());

    // Conta sem o vínculo: o request não sai (#532).
    await expect(result.current()).rejects.toMatchObject({
      name: "AccessLinkPendingError",
    });

    // A conta passa a ter o vínculo e o token segue sem o claim: é a instância
    // sem os custom claims, e o token vai ao backend falhar alto (#487).
    clerk.user = { publicMetadata: { supabase_uid: LINKED_CLAIMS.supabase_uid } };
    rerender();
    await expect(result.current()).resolves.toBe(unlinked);
  });
});
