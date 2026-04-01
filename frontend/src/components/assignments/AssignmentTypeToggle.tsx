"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

interface AssignmentTypeToggleProps {
  current: "codificacao" | "comparacao";
}

export function AssignmentTypeToggle({ current }: AssignmentTypeToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setType = (type: "codificacao" | "comparacao") => {
    const params = new URLSearchParams(searchParams.toString());
    if (type === "codificacao") {
      params.delete("type");
    } else {
      params.set("type", type);
    }
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  return (
    <div className="inline-flex rounded-md border p-0.5">
      <button
        onClick={() => setType("codificacao")}
        className={cn(
          "rounded-sm px-3 py-1 text-sm transition-colors",
          current === "codificacao"
            ? "bg-brand text-brand-foreground font-medium"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Codificação
      </button>
      <button
        onClick={() => setType("comparacao")}
        className={cn(
          "rounded-sm px-3 py-1 text-sm transition-colors",
          current === "comparacao"
            ? "bg-brand text-brand-foreground font-medium"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Comparação
      </button>
    </div>
  );
}
