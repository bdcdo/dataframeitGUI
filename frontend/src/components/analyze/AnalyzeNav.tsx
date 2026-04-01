"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const analyzeTabs = [
  { label: "Atribuições", href: "assignments" },
  { label: "Codificar", href: "code" },
  { label: "Comparar", href: "compare" },
];

interface AnalyzeNavProps {
  projectId: string;
}

export function AnalyzeNav({ projectId }: AnalyzeNavProps) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 border-b px-4 py-1">
      {analyzeTabs.map((tab) => {
        const href = `/projects/${projectId}/analyze/${tab.href}`;
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
