"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle } from "lucide-react";

interface DocListItemProps {
  icon: React.ReactNode;
  title: string;
  isCurrent: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

export function DocListItem({
  icon,
  title,
  isCurrent,
  onClick,
  children,
}: DocListItemProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60",
          isCurrent && "bg-brand/10 hover:bg-brand/15",
        )}
      >
        <div className="flex items-center gap-1.5">
          {icon}
          <span
            className={cn("truncate font-medium", isCurrent && "text-brand")}
            title={title}
          >
            {title}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 pl-4.5">
          {children}
        </div>
      </button>
    </li>
  );
}

export function DocListDoneIcon({ isDone }: { isDone: boolean }) {
  return isDone ? (
    <CheckCircle2 className="size-3 text-green-600" />
  ) : (
    <Circle className="size-3 text-muted-foreground/50" />
  );
}

export function DocListBadge({
  className,
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      className={cn("h-4 px-1 text-[10px] font-normal", className)}
      {...props}
    />
  );
}
