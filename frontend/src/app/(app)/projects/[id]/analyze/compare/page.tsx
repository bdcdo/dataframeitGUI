import { Suspense } from "react";
import { cookies } from "next/headers";
import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getProjectAccessContext,
  resolveProjectQueueIdentity,
} from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { ComparePage } from "@/components/compare/ComparePage";
import { loadCompareQueue } from "@/lib/compare-queue";
import {
  COMPARE_SPLIT_COOKIE,
  parseSplitLayout,
} from "@/lib/compare-split-layout";

export type { DocCoverage } from "@/lib/compare-queue";

export default async function ComparePageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ id }, sp, user, supabase, cookieStore] = await Promise.all([
    params,
    searchParams,
    requirePageAuthUser(),
    createSupabaseServer(),
    cookies(),
  ]);

  // Fila pessoal pertence à identidade canônica; a impersonação master
  // (?viewAsUser=, mesmo param do Codificar) tem precedência. Uma falha na
  // resolução interrompe a rota em vez de parecer uma fila vazia. Vai como
  // Promise para correr junto com as buscas do carregador.
  const identity = getProjectAccessContext(id, user).then((rawAccess) => {
    const access = requireResolvedProjectAccess(rawAccess);
    return {
      ...resolveProjectQueueIdentity(access, sp.viewAsUser),
      isCoordinator: access.isCoordinator,
    };
  });

  const queue = await loadCompareQueue(supabase, id, identity, sp);

  if (!queue.ok) {
    console.error("Failed to fetch responses for compare:", queue.error);
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Erro ao carregar respostas. Tente novamente.
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Carregando…</div>}>
      <ComparePage
        projectId={id}
        {...queue.props}
        // Lida aqui, e não no cliente, para o HTML já sair na divisão salva.
        savedSplit={parseSplitLayout(cookieStore.get(COMPARE_SPLIT_COOKIE)?.value)}
      />
    </Suspense>
  );
}
