"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "Tudo", days: null },
];

function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoDaysAgo(days: number): string {
  return toISODate(new Date(Date.now() - days * 86_400_000));
}

function formatBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function DateSinceFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const current = searchParams.get("since");

  const activeDays: number | null | "custom" = (() => {
    if (!current) return null;
    const match = PRESETS.find(
      (p) => p.days !== null && isoDaysAgo(p.days) === current,
    );
    return match?.days ?? "custom";
  })();

  const setSince = (days: number | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (days == null) {
      params.delete("since");
    } else {
      params.set("since", isoDaysAgo(days));
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  return (
    <div className="flex items-center gap-2 text-xs" aria-busy={isPending}>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        Desde:
        {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
      </span>
      <div className="flex items-center gap-1">
        {PRESETS.map((p) => {
          const isActive =
            (p.days === null && activeDays === null) ||
            (p.days !== null && activeDays === p.days);
          return (
            <Button
              key={p.label}
              variant={isActive ? "default" : "outline"}
              size="xs"
              onClick={() => setSince(p.days)}
              disabled={isPending}
              className={cn(!isActive && "text-muted-foreground")}
            >
              {p.label}
            </Button>
          );
        })}
      </div>
      {current && activeDays === "custom" && (
        <span className="text-muted-foreground">
          (desde {formatBR(current)})
        </span>
      )}
    </div>
  );
}
