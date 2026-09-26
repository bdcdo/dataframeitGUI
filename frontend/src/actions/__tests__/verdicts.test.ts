import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectIdentityActionHarness } from "./project-identity-harness";
const resolveMemberUserId = vi.hoisted(() =>
  vi.fn(async () => "canonical-member"),
);
const harness = createProjectIdentityActionHarness(resolveMemberUserId);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => harness.authModule);
vi.mock("@/lib/supabase/server", () => harness.supabaseServerModule);

beforeEach(() => {
  harness.reset({ verdict_acknowledgments: { error: null } });
  resolveMemberUserId.mockReset();
  resolveMemberUserId.mockResolvedValue("canonical-member");
});

describe("acknowledgeVerdict", () => {
  it("grava o reconhecimento em nome do membro canônico", async () => {
    const { acknowledgeVerdict } = await import("@/actions/verdicts");

    const result = await acknowledgeVerdict(
      "review-1",
      "project-1",
      "accepted",
      "Sim",
    );

    expect(result).toEqual({});
    // O veredito que a tela mostrou vai junto: o gatilho só aceita o atual (#758).
    expect(harness.supabase.writeCalls).toContainEqual({
      table: "verdict_acknowledgments",
      op: "upsert",
      payload: {
        review_id: "review-1",
        respondent_id: "canonical-member",
        status: "accepted",
        comment: null,
        acknowledged_verdict: "Sim",
      },
    });
  });

  // O gatilho do banco trata a coluna ausente (ou NULL) como o frontend
  // anterior e carimba o veredito atual sem conferir o que a tela mostrou.
  // A action nova sempre manda a coluna, inclusive o veredito em branco (o
  // voto no grupo de respostas vazias), que não pode virar NULL.
  it.each<["accepted" | "questioned", string, string | undefined]>([
    ["accepted", "Sim", undefined],
    ["questioned", "Sim", "por quê?"],
    ["accepted", "", undefined],
    ["questioned", "", "e o branco?"],
  ])("sempre manda acknowledged_verdict (%s, veredito %j)", async (status, verdict, comment) => {
    const { acknowledgeVerdict } = await import("@/actions/verdicts");
    await acknowledgeVerdict("review-1", "project-1", status, verdict, comment);
    const write = harness.supabase.writeCalls.find((call) => call.table === "verdict_acknowledgments");
    expect(write?.payload).toHaveProperty("acknowledged_verdict", verdict);
  });

  it("não grava quando a identidade canônica está indisponível", async () => {
    resolveMemberUserId.mockRejectedValueOnce(
      new Error("identity unavailable"),
    );
    const { acknowledgeVerdict } = await import("@/actions/verdicts");

    const result = await acknowledgeVerdict(
      "review-1",
      "project-1",
      "accepted",
      "Sim",
    );

    expect(result).toEqual({
      error: "Não foi possível verificar sua identidade no projeto.",
    });
    expect(harness.supabase.writeCalls).toEqual([]);
  });
});
