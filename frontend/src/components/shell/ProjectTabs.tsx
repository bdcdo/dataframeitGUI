"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface ProjectTabsProps {
  projectId: string;
  isCoordinator: boolean;
}

const tabs = [
  { label: "Documentos", href: "documents" },
  { label: "Atribuições", href: "assignments" },
  { label: "Codificar", href: "code" },
  { label: "Comparar", href: "compare" },
  { label: "Estatísticas", href: "stats" },
  { label: "Exportar", href: "export" },
  { label: "Configurações", href: "config", coordinatorOnly: true },
];

export function ProjectTabs({ projectId, isCoordinator }: ProjectTabsProps) {
  const pathname = usePathname();

  const visibleTabs = tabs.filter(
    (tab) => !tab.coordinatorOnly || isCoordinator
  );

  return (
    <nav className="flex h-10 items-center gap-1 border-b px-4">
      {visibleTabs.map((tab) => {
        const href = `/projects/${projectId}/${tab.href}`;
        const isActive = pathname.startsWith(href);

        return (
          <Link
            key={tab.href}
            href={href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              isActive
                ? "bg-brand/10 font-medium text-brand"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
