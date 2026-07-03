"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { savePrompt } from "@/actions/schema";
import { usePromptPreview } from "@/hooks/usePromptPreview";

interface PromptCardProps {
  projectId: string;
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  projectDescription: string;
}

export function PromptCard({
  projectId,
  prompt,
  setPrompt,
  projectDescription,
}: PromptCardProps) {
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { previewPrompt, previewLoading, previewError } = usePromptPreview(
    projectDescription,
    prompt,
    previewOpen,
  );

  const handleSavePrompt = async () => {
    setSavingPrompt(true);
    try {
      const r = await savePrompt(projectId, prompt);
      if (r?.error) toast.error(r.error);
      else toast.success("Prompt salvo!");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar prompt");
    }
    setSavingPrompt(false);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Prompt</CardTitle>
        <Button
          size="sm"
          onClick={() => void handleSavePrompt()}
          disabled={savingPrompt}
          className="bg-brand hover:bg-brand/90 text-brand-foreground"
        >
          Salvar
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          O prompt é montado automaticamente a partir da descrição do projeto e
          das instruções de cada campo (help text no schema). Use o campo abaixo
          para adicionar instruções complementares.
        </p>

        <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            Ver preview do prompt final
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 rounded-md border bg-muted/50 p-4 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto">
              {(previewLoading || (previewPrompt === null && !previewError)) && (
                <p className="text-muted-foreground italic">
                  Carregando preview…
                </p>
              )}
              {!previewLoading && previewError && (
                <p className="text-destructive">{previewError}</p>
              )}
              {!previewLoading && !previewError && previewPrompt !== null && (
                <>
                  {previewPrompt}
                  {!projectDescription.trim() && (
                    <p className="mt-2 text-muted-foreground italic">
                      (Sem descrição do projeto, configure em Config → Geral)
                    </p>
                  )}
                </>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="space-y-1.5">
          <Label className="text-sm">Instruções adicionais (opcional)</Label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Adicione aqui instruções específicas que complementam o prompt automático..."
            className="min-h-[100px] resize-y text-sm"
          />
        </div>
      </CardContent>
    </Card>
  );
}
