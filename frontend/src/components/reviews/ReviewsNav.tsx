"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const reviewsTabs: Array<{
  label: string;
  href: string;
}> = [
  { label: "Gabarito", href: "gabarito" },
  { label: "Meu Gabarito", href: "my-verdicts" },
  { label: "Erros LLM", href: "llm-insights" },
  { label: "Comentários", href: "comments" },
];

interface ReviewsNavProps {
  projectId: string;
}

export function ReviewsNav({ projectId }: ReviewsNavProps) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 border-b px-4 py-1">
      {reviewsTabs.map((tab) => {
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
