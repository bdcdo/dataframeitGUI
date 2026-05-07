"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2, Plus, Check } from "lucide-react";
import { toast } from "sonner";
import {
  createRound,
  deleteRound,
  setCurrentRound,
  setRoundStrategy,
} from "@/actions/rounds";
import type { Round, RoundStrategy } from "@/lib/types";

interface Props {
  projectId: string;
  strategy: RoundStrategy;
  currentRoundId: string | null;
  currentVersion: string;
  rounds: Round[];
  isCoordinator: boolean;
}

export function RoundsConfig({
  projectId,
  strategy,
  currentRoundId,
  currentVersion,
  rounds,
  isCoordinator,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [newLabel, setNewLabel] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Round | null>(null);

  const handleStrategyChange = (next: string) => {
    if (next !== "schema_version" && next !== "manual") return;
    startTransition(async () => {
      const r = await setRoundStrategy(projectId, next as RoundStrategy);
      if (r.error) toast.error(r.error);
      else {
        toast.success("Estratégia atualizada");
        router.refresh();
      }
    });
  };

  const handleCreate = () => {
    const label = newLabel.trim();
    if (!label) return;
    startTransition(async () => {
      const r = await createRound(projectId, label, rounds.length === 0);
      if (r.error) toast.error(r.error);
      else {
        toast.success("Rodada criada");
        setNewLabel("");
        router.refresh();
      }
    });
  };

  const handleSetCurrent = (roundId: string) => {
    startTransition(async () => {
      const r = await setCurrentRound(projectId, roundId);
      if (r.error) toast.error(r.error);
      else {
        toast.success("Rodada atual atualizada");
        router.refresh();
      }
    });
  };

  const handleConfirmDelete = () => {
    const round = pendingDelete;
    if (!round) return;
    setPendingDelete(null);
    startTransition(async () => {
      const r = await deleteRound(projectId, round.id);
      if (r.error) toast.error(r.error);
      else {
        toast.success("Rodada excluída");
        router.refresh();
      }
    });
  };

  const disabled = !isCoordinator || isPending;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Rodadas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Define como as rodadas de codificação são identificadas. O filtro na aba
          Codificar usa essa configuração para separar o que ainda precisa ser
          respondido na rodada vigente das respostas de rodadas anteriores.
        </p>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div>
          <Label className="text-sm font-medium">Estratégia</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Como definir a rodada atual.
          </p>
        </div>
        <RadioGroup
          value={strategy}
          onValueChange={handleStrategyChange}
          disabled={disabled}
          className="gap-3"
        >
          <div className="flex items-start gap-3 rounded-md border p-3">
            <RadioGroupItem value="schema_version" id="strategy-schema" className="mt-0.5" />
            <div className="flex-1">
              <Label htmlFor="strategy-schema" className="text-sm font-medium">
                Versão do schema (automático)
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                A rodada atual é a versão atual do formulário (
                <span className="font-mono">{currentVersion}</span>). Cada bump de
                versão inicia uma nova rodada implicitamente.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <RadioGroupItem value="manual" id="strategy-manual" className="mt-0.5" />
            <div className="flex-1">
              <Label htmlFor="strategy-manual" className="text-sm font-medium">
                Rodadas manuais
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                Você cria e nomeia rodadas explicitamente. Marque uma como atual
                para que novas respostas sejam atribuídas a ela.
              </p>
            </div>
          </div>
        </RadioGroup>
      </div>

      {strategy === "manual" && (
        <div className="rounded-lg border p-4 space-y-4">
          <div>
            <Label className="text-sm font-medium">Rodadas do projeto</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Marque qual é a rodada atual. Respostas novas em /analyze/code serão
              associadas a ela.
            </p>
          </div>

          <div className="flex gap-2">
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Ex.: Piloto, Rodada 2…"
              disabled={disabled}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
            <Button
              onClick={handleCreate}
              disabled={disabled || !newLabel.trim()}
              size="sm"
              className="shrink-0"
            >
              <Plus className="h-4 w-4" />
              Criar
            </Button>
          </div>

          {rounds.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              Nenhuma rodada criada ainda.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {rounds.map((r) => {
                const isCurrent = r.id === currentRoundId;
                return (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm truncate">{r.label}</span>
                      {isCurrent && (
                        <Badge variant="default" className="text-xs">
                          Atual
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!isCurrent && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSetCurrent(r.id)}
                          disabled={disabled}
                          className="h-7 text-xs"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Tornar atual
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setPendingDelete(r)}
                        disabled={disabled}
                        className="h-7 w-7"
                        aria-label="Excluir rodada"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {!isCoordinator && (
        <p className="text-xs text-muted-foreground">
          Apenas coordenadores podem alterar essas configurações.
        </p>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir rodada?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && (
                <>
                  Excluir a rodada <strong>{pendingDelete.label}</strong>? As respostas
                  associadas continuam preservadas, mas ficam sem rodada (aparecem como
                  &quot;Sem rodada&quot; no filtro).
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete} disabled={isPending}>
              {isPending ? "Excluindo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
