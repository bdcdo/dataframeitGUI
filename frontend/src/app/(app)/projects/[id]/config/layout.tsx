"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { cn } from "@/lib/utils";

const configTabs = [
  { label: "Schema", href: "schema" },
  { label: "Membros", href: "members" },
  { label: "Regras", href: "rules" },
];

export default function ConfigLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useParams();
  const projectId = params.id as string;

  return (
    <div className="flex flex-col">
      <nav className="flex items-center gap-1 border-b px-4 py-1">
        {configTabs.map((tab) => {
          const href = `/projects/${projectId}/config/${tab.href}`;
          const isActive = pathname.startsWith(href);
          return (
            <Link
              key={tab.href}
              href={href}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                isActive
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex-1">{children}</div>
    </div>
  );
}
