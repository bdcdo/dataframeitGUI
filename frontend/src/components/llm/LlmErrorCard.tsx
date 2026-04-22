"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AlertCircle, ChevronRight, Copy, X, Check } from "lucide-react";
import { toast } from "sonner";

export interface LlmErrorInfo {
  message: string;
  type: string | null;
  traceback: string | null;
  line: number | null;
  column: number | null;
  pydanticCode: string | null;
}

interface LlmErrorCardProps {
  id?: string;
  error: LlmErrorInfo;
  onDismiss: () => void;
}

function getCodeWindow(
  code: string,
  targetLine: number,
  radius = 3
): { lineNumber: number; text: string; highlighted: boolean }[] {
  const lines = code.split("\n");
  const start = Math.max(1, targetLine - radius);
  const end = Math.min(lines.length, targetLine + radius);
  const out: { lineNumber: number; text: string; highlighted: boolean }[] = [];
  for (let i = start; i <= end; i++) {
    out.push({
      lineNumber: i,
      text: lines[i - 1] ?? "",
      highlighted: i === targetLine,
    });
  }
  return out;
}

export function LlmErrorCard({ id, error, onDismiss }: LlmErrorCardProps) {
  const [copied, setCopied] = useState(false);

  const codeWindow =
    error.line && error.pydanticCode
      ? getCodeWindow(error.pydanticCode, error.line)
      : null;

  const handleCopy = async () => {
    const parts: string[] = [];
    if (error.type) parts.push(`Tipo: ${error.type}`);
    parts.push(`Mensagem: ${error.message}`);
    if (error.line) {
      parts.push(
        `Local: linha ${error.line}${
          error.column != null ? `, coluna ${error.column}` : ""
        } do código Pydantic`
      );
    }
    if (codeWindow) {
      parts.push("", "Trecho:");
      for (const l of codeWindow) {
        parts.push(`${l.highlighted ? ">>" : "  "} ${l.lineNumber} | ${l.text}`);
      }
    }
    if (error.traceback) parts.push("", "Traceback:", error.traceback);
    try {
      await navigator.clipboard.writeText(parts.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar para a área de transferência.");
    }
  };

  return (
    <Card
      id={id}
      className="border-destructive/40 bg-destructive/5"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="destructive">{error.type ?? "Erro"}</Badge>
              {error.line != null && (
                <span className="text-xs text-muted-foreground">
                  linha {error.line}
                  {error.column != null ? `, coluna ${error.column}` : ""}
                </span>
              )}
            </div>
            <p className="text-sm font-medium leading-snug">
              Falha ao rodar o LLM
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onDismiss}
          aria-label="Fechar"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        <pre className="whitespace-pre-wrap rounded-md border bg-background p-3 text-xs font-mono">
          {error.message}
        </pre>

        {codeWindow && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              Trecho do código Pydantic
            </p>
            <div className="overflow-x-auto rounded-md border bg-background font-mono text-xs">
              <table className="w-full border-collapse">
                <tbody>
                  {codeWindow.map((l) => (
                    <tr
                      key={l.lineNumber}
                      className={
                        l.highlighted
                          ? "bg-destructive/10"
                          : "hover:bg-muted/30"
                      }
                    >
                      <td className="select-none border-r px-2 py-0.5 text-right text-muted-foreground">
                        {l.lineNumber}
                      </td>
                      <td className="whitespace-pre px-2 py-0.5">
                        {l.text || " "}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error.traceback && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              Stack trace completo
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-72 overflow-auto rounded-md border bg-background p-3 text-[11px] font-mono text-muted-foreground">
                {error.traceback}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={handleCopy}>
            {copied ? (
              <>
                <Check className="mr-1.5 h-3.5 w-3.5" /> Copiado
              </>
            ) : (
              <>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar diagnóstico
              </>
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Fechar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
