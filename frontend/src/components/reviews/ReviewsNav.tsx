"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const reviewsTabs: Array<{
  label: string;
  href: string;
  coordinatorOnly?: boolean;
  researcherOnly?: boolean;
}> = [
  { label: "Gabarito", href: "gabarito" },
  { label: "Meu Gabarito", href: "my-verdicts" },
  { label: "Matriz de Confusão", href: "confusion" },
  { label: "Erros LLM", href: "llm-insights" },
  { label: "Comentários", href: "comments" },
  { label: "Exportar", href: "export" },
  { label: "Respondentes", href: "respondents", coordinatorOnly: true },
  { label: "Docs Difíceis", href: "difficulty", coordinatorOnly: true },
];

interface ReviewsNavProps {
  projectId: string;
  isCoordinator: boolean;
}

export function ReviewsNav({ projectId, isCoordinator }: ReviewsNavProps) {
  const pathname = usePathname();

  const visibleTabs = reviewsTabs.filter(
    (tab) =>
      (!tab.coordinatorOnly || isCoordinator) &&
      (!tab.researcherOnly || !isCoordinator),
  );

  return (
    <nav className="flex items-center gap-1 border-b px-4 py-1">
      {visibleTabs.map((tab) => {
        const href = `/projects/${projectId}/reviews/${tab.href}`;
        const isActive = pathname.startsWith(href);
        return (
          <Link
            key={tab.href}
            href={href}
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              isActive
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
