"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, Users } from "lucide-react";
import { LlmRunningBadge } from "@/components/llm/LlmRunningBadge";

interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

interface ProjectTabsProps {
  projectId: string;
  isCoordinator: boolean;
  isMaster?: boolean;
  projectMembers?: ProjectMember[];
  isLlmRunning?: boolean;
}

const tabs = [
  { label: "Meu Progresso", href: "my-progress" },
  { label: "Analisar", href: "analyze" },
  { label: "Revisar", href: "reviews" },
  { label: "LLM", href: "llm", coordinatorOnly: true },
  { label: "Configurações", href: "config", coordinatorOnly: true },
];

export function ProjectTabs({
  projectId,
  isCoordinator,
  isMaster = false,
  projectMembers = [],
  isLlmRunning = false,
}: ProjectTabsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const viewAsUserId = isMaster ? searchParams.get("viewAsUser") : null;
  const viewAsResearcher =
    isCoordinator &&
    !viewAsUserId &&
    searchParams.get("viewAs") === "pesquisador";
  const effectiveIsCoordinator = isCoordinator && !viewAsResearcher;

  const impersonatedMember = viewAsUserId
    ? projectMembers.find((m) => m.userId === viewAsUserId)
    : null;

  const visibleTabs = tabs.filter(
    (tab) => !tab.coordinatorOnly || effectiveIsCoordinator
  );

  const toggleViewAs = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (viewAsResearcher) {
      params.delete("viewAs");
    } else {
      params.set("viewAs", "pesquisador");
    }
    params.delete("viewAsUser");
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  const selectImpersonation = (userId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (userId) {
      params.set("viewAsUser", userId);
      params.delete("viewAs");
    } else {
      params.delete("viewAsUser");
    }
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  return (
    <div>
      {viewAsUserId && impersonatedMember && (
        <div className="bg-violet-50 text-violet-800 text-xs text-center py-1 dark:bg-violet-950/50 dark:text-violet-200">
          Visualizando como{" "}
          <span className="font-medium">{impersonatedMember.name}</span>
          {" "}({impersonatedMember.role}) —{" "}
          <button
            onClick={() => selectImpersonation(null)}
            className="underline hover:no-underline font-medium"
          >
            voltar para master
          </button>
        </div>
      )}
      {viewAsResearcher && !viewAsUserId && (
        <div className="bg-amber-50 text-amber-800 text-xs text-center py-1 dark:bg-amber-950/50 dark:text-amber-200">
          Visualizando como pesquisador —{" "}
          <button
            onClick={toggleViewAs}
            className="underline hover:no-underline font-medium"
          >
            voltar para coordenador
          </button>
        </div>
      )}
      <nav className="flex h-10 items-center gap-1 border-b px-4">
        {visibleTabs.map((tab) => {
          const qs = searchParams.toString();
          const href = `/projects/${projectId}/${tab.href}${qs ? `?${qs}` : ""}`;
          const isActive = pathname.startsWith(`/projects/${projectId}/${tab.href}`);

          return (
            <Link
              key={tab.href}
              href={href}
              className={cn(
                "relative px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
              {tab.href === "llm" && isLlmRunning && <LlmRunningBadge />}
              {isActive && (
                <span className="absolute inset-x-1 -bottom-[5px] h-0.5 rounded-full bg-brand" />
              )}
            </Link>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          {isMaster && projectMembers.length > 0 && (
            <div className="relative flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={viewAsUserId || ""}
                onChange={(e) =>
                  selectImpersonation(e.target.value || null)
                }
                className={cn(
                  "h-7 rounded-md border bg-background px-2 text-xs transition-colors",
                  viewAsUserId
                    ? "border-violet-300 text-violet-800 dark:border-violet-700 dark:text-violet-200"
                    : "border-input text-muted-foreground"
                )}
              >
                <option value="">Ver como...</option>
                {projectMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </div>
          )}

          {isCoordinator && !isMaster && (
            <button
              onClick={toggleViewAs}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                viewAsResearcher
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {viewAsResearcher ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
              {viewAsResearcher ? "Visão Coordenador" : "Ver como Pesquisador"}
            </button>
          )}
        </div>
      </nav>
    </div>
  );
}
