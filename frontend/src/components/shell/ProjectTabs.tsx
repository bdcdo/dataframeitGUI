"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Eye, EyeOff } from "lucide-react";

interface ProjectTabsProps {
  projectId: string;
  isCoordinator: boolean;
}

const tabs = [
  { label: "Meu Progresso", href: "my-progress" },
  { label: "Atribuições", href: "assignments" },
  { label: "Codificar", href: "code" },
  { label: "Comparar", href: "compare" },
  { label: "Revisões", href: "reviews" },
  { label: "Estatísticas", href: "stats" },
  { label: "LLM", href: "llm", coordinatorOnly: true },
  { label: "Discussões", href: "discussions" },
  { label: "Configurações", href: "config", coordinatorOnly: true },
];

export function ProjectTabs({ projectId, isCoordinator }: ProjectTabsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const viewAsResearcher =
    isCoordinator && searchParams.get("viewAs") === "pesquisador";
  const effectiveIsCoordinator = isCoordinator && !viewAsResearcher;

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
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  return (
    <div>
      {viewAsResearcher && (
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
              {isActive && (
                <span className="absolute inset-x-1 -bottom-[5px] h-0.5 rounded-full bg-brand" />
              )}
            </Link>
          );
        })}
        {isCoordinator && (
          <button
            onClick={toggleViewAs}
            className={cn(
              "ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
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
      </nav>
    </div>
  );
}
