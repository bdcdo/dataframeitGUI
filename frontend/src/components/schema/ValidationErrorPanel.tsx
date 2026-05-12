"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OctagonX, Copy, Check, X } from "lucide-react";
import { toast } from "sonner";

interface ValidationErrorPanelProps {
  errors: string[];
  onDismiss: () => void;
}

export function ValidationErrorPanel({
  errors,
  onDismiss,
}: ValidationErrorPanelProps) {
  const [copied, setCopied] = useState(false);

  if (errors.length === 0) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(errors.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar para a área de transferência.");
    }
  };

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <OctagonX className="h-5 w-5 shrink-0 text-destructive" />
          <p className="text-sm font-medium leading-snug">
            {errors.length === 1
              ? "1 erro impede o save"
              : `${errors.length} erros impedem o save`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5"
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copiado
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copiar
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDismiss}
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground select-text">
          {errors.map((err, i) => (
            <li key={i} className="leading-snug">
              {err}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
