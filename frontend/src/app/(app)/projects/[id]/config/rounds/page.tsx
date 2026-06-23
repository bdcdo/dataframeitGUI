import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RoundsConfig } from "@/components/config/RoundsConfig";
import type { Round, RoundStrategy } from "@/lib/types";
import { versionLabel } from "@/lib/rounds";

export default async function RoundsConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    getAuthUser(),
    createSupabaseServer(),
  ]);
  if (!user) redirect("/auth/login");

  const [{ data: project }, { data: rounds }, access] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "round_strategy, current_round_id, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("rounds")
      .select("id, project_id, label, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    getProjectAccessContext(id, user.id, user.isMaster),
  ]);

  // Fail-open em erro transitorio, alinhado ao gate fail-open de config/layout:
  // isCoordinator aqui so liga affordances de config (mutacoes de rodada
  // re-checam coordenador em actions/rounds.ts). getProjectAccessContext cobre
  // isMaster e e cache-hit da leitura ja feita pelo config/layout.
  const isCoordinator = access.isCoordinator || access.queryFailed;

  const currentVersion = versionLabel({
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  });

  return (
    <div className="mx-auto max-w-3xl p-6">
      <RoundsConfig
        projectId={id}
        strategy={(project?.round_strategy as RoundStrategy) ?? "schema_version"}
        currentRoundId={project?.current_round_id ?? null}
        currentVersion={currentVersion}
        rounds={(rounds ?? []) as Round[]}
        isCoordinator={isCoordinator}
      />
    </div>
  );
}
