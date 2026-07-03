"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LayoutGrid, Code, Rocket, History } from "lucide-react";
import { cn } from "@/lib/utils";

interface SchemaEditorHeaderProps {
  mode: "gui" | "code";
  onSwitchToGUI: () => void;
  onSwitchToCode: () => void;
  currentVersion: string;
  fieldCount: number;
  llmOnlyCount: number;
  isPending: boolean;
  onOpenBackfill: () => void;
  onOpenMajor: () => void;
}

/** Header do editor de schema: toggle Visual/Código, versão, contadores e ações. */
export function SchemaEditorHeader({
  mode,
  onSwitchToGUI,
  onSwitchToCode,
  currentVersion,
  fieldCount,
  llmOnlyCount,
  isPending,
  onOpenBackfill,
  onOpenMajor,
}: SchemaEditorHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 text-xs gap-1.5",
              mode === "gui" && "bg-background shadow-sm"
            )}
            onClick={() => (mode === "code" ? onSwitchToGUI() : undefined)}
          >
            <LayoutGrid className="size-3.5" />
            Visual
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 text-xs gap-1.5",
              mode === "code" && "bg-background shadow-sm"
            )}
            onClick={() => (mode === "gui" ? onSwitchToCode() : undefined)}
          >
            <Code className="size-3.5" />
            Código
          </Button>
        </div>
        <Badge
          variant="outline"
          className="h-6 px-2 font-mono text-xs"
          title="Versão atual do schema"
        >
          v{currentVersion}
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        {fieldCount > 0 && (
          <Badge className="bg-green-500/10 text-green-700 text-xs">
            {fieldCount} {fieldCount === 1 ? "campo" : "campos"}
          </Badge>
        )}
        {llmOnlyCount > 0 && (
          <Badge className="bg-blue-500/10 text-blue-700 text-xs">
            {llmOnlyCount} LLM-only
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs text-muted-foreground"
          onClick={onOpenBackfill}
          disabled={isPending}
          title="Reconstruir versão a partir do histórico de mudanças"
        >
          <History className="size-3.5" />
          Reconstruir histórico
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onOpenMajor}
          disabled={isPending}
          title="Consolidar baseline e bumpar MAJOR"
        >
          <Rocket className="size-3.5" />
          Publicar MAJOR
        </Button>
      </div>
    </div>
  );
}
