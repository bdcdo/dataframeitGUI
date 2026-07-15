"use client";

import { useActionState, useState } from "react";
import { createProject } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isLlmEnabled } from "@/lib/feature-flags";
import {
  getAutomationModeOption,
  getAvailableAutomationModes,
  getDefaultAutomationMode,
  isAutomationMode,
  type AutomationMode,
} from "@/lib/automation-modes";

export default function NewProjectPage() {
  const [state, formAction, pending] = useActionState(createProject, null);
  const llmEnabled = isLlmEnabled();
  const availableModes = getAvailableAutomationModes(llmEnabled);
  const [mode, setMode] = useState<AutomationMode>(() =>
    getDefaultAutomationMode(llmEnabled),
  );
  const modeMeta = getAutomationModeOption(mode);

  return (
    <main className="mx-auto max-w-lg p-6">
      <Card>
        <CardHeader>
          <CardTitle>Novo Projeto</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            {state?.error && (
              <p className="text-sm text-destructive">{state.error}</p>
            )}
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                Nome do projeto
              </label>
              <Input
                id="name"
                name="name"
                placeholder="Ex: Revisão sistemática — intervenções em doenças raras"
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="description" className="text-sm font-medium">
                Descrição
              </label>
              <Textarea
                id="description"
                name="description"
                placeholder="Breve descrição do objetivo da revisão..."
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="automation_mode_trigger" className="text-sm font-medium">
                Modo de automação
              </label>
              {/* Input hidden: o form é FormData-based; o Select (Radix) controla
                  o estado e o hidden carrega o valor para a Server Action. */}
              <input type="hidden" name="automation_mode" value={mode} />
              <Select
                value={mode}
                onValueChange={(value) => {
                  if (isAutomationMode(value)) setMode(value);
                }}
              >
                <SelectTrigger id="automation_mode_trigger" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableModes.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modeMeta && (
                <p className="text-xs text-muted-foreground">
                  {modeMeta.description} Você pode mudar isso depois em
                  Configurações › Regras.
                </p>
              )}
            </div>
            <Button
              type="submit"
              disabled={pending}
              className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
            >
              {pending ? "Criando..." : "Criar Projeto"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
