"use client";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

interface FieldProgressProps {
  fields: {
    name: string;
    description: string;
    progress: number;
    priority: "ALTA" | "MEDIA" | "BAIXA";
  }[];
}

export function FieldProgress({ fields }: FieldProgressProps) {
  return (
    <div className="space-y-3">
      {fields.map((f) => (
        <div key={f.name} className="flex items-center gap-3">
          <div className="w-48 truncate text-sm">{f.description}</div>
          <Progress value={f.progress} className="flex-1" />
          <span className="w-12 text-right text-sm text-muted-foreground">{f.progress}%</span>
          <Badge
            variant={f.priority === "ALTA" ? "destructive" : "secondary"}
            className="w-16 justify-center text-xs"
          >
            {f.priority}
          </Badge>
        </div>
      ))}
    </div>
  );
}
