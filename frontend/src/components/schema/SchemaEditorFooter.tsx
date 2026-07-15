"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SchemaEditorFooterProps {
  mode: "gui" | "code";
  saveDisabled: boolean;
  statusMessage: string | null;
  onSave: () => void;
}

export function SchemaEditorFooter({
  mode,
  saveDisabled,
  statusMessage,
  onSave,
}: SchemaEditorFooterProps) {
  if (mode === "code") {
    return (
      <div className="flex items-center gap-2 border-t px-4 py-2">
        <span className="text-xs text-muted-foreground">
          Visualização somente leitura — para editar, use o modo Visual.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-t px-4 py-2">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saveDisabled}
        className="bg-brand text-brand-foreground hover:bg-brand/90"
      >
        Salvar
      </Button>
      {statusMessage && (
        <output className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {statusMessage}
        </output>
      )}
    </div>
  );
}
