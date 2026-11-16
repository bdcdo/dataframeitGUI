"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const baseTabs = [
  { label: "Atribuições", href: "assignments" },
  { label: "Codificar", href: "code" },
];

interface AnalyzeNavProps {
  projectId: string;
  showAutoReview?: boolean;
  showArbitragem?: boolean;
  showCompare?: boolean;
}

export function AnalyzeNav(props: AnalyzeNavProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <AnalyzeNavInner {...props} />
    </Suspense>
  );
}

function AnalyzeNavInner({
  projectId,
  showAutoReview = false,
  showArbitragem = false,
  showCompare = false,
}: AnalyzeNavProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hrefOf = (tab: string) => `/projects/${projectId}/analyze/${tab}`;

  // As flags vêm do layout, que não recebe `searchParams` e por isso sonda as
  // filas do próprio usuário. Com o master "visualizando como" (`?viewAsUser=`)
  // a página mostra a fila de outro membro, e a aba dela podia não existir:
  // nas telas que aceitam a impersonação, a aba da rota aberta aparece sempre.
  // As demais abas seguem sendo as do próprio master.
  const impersonating = searchParams.has("viewAsUser");
  const onImpersonatedRoute = (tab: string) =>
    impersonating && pathname.startsWith(hrefOf(tab));

  const tabs = [
    ...baseTabs,
    ...(showCompare || onImpersonatedRoute("compare")
      ? [{ label: "Comparar", href: "compare" }]
      : []),
    ...(showAutoReview
      ? [{ label: "Auto-revisão", href: "auto-revisao" }]
      : []),
    ...(showArbitragem || onImpersonatedRoute("arbitragem")
      ? [{ label: "Arbitragem", href: "arbitragem" }]
      : []),
  ];

  return (
    <nav className="flex items-center gap-1 border-b px-4 py-1">
      {tabs.map((tab) => {
        const href = hrefOf(tab.href);
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
