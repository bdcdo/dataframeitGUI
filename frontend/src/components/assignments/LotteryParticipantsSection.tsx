"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { LotteryMember } from "./lottery-dialog-types";
import type { LotteryParamsState } from "./useLotteryParams";
import {
  capValue,
  isParticipant,
  weightValue,
} from "./lottery-participant-values";

// Seção "Participantes" do LotteryDialog (US3): toggle de participação e
// inputs de peso/limite por membro.
export function LotteryParticipantsSection({
  members,
  params,
}: {
  members: LotteryMember[];
  params: Pick<
    LotteryParamsState,
    | "participantOverrides"
    | "setParticipantOverrides"
    | "weightInputs"
    | "setWeightInputs"
    | "capInputs"
    | "setCapInputs"
  >;
}) {
  const {
    participantOverrides,
    setParticipantOverrides,
    weightInputs,
    setWeightInputs,
    capInputs,
    setCapInputs,
  } = params;

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">Participantes</h4>
      <p className="text-xs text-muted-foreground">
        Quem está ligado entra no sorteio. Pesquisadores começam
        ligados; coordenadores, desligados. O <strong>peso</strong>{" "}
        ajusta a carga relativa (0,5 = metade dos demais); o{" "}
        <strong>limite</strong> (opcional) é o teto de docs novos da
        pessoa neste sorteio. Os valores ficam salvos para o próximo.
      </p>
      {members.map((m) => (
        <div key={m.userId} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label
              htmlFor={`member-${m.userId}`}
              className="font-normal"
            >
              {m.name}
              {m.role === "coordenador" && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  coordenador
                </span>
              )}
              {m.pending && (
                <Badge
                  variant="secondary"
                  className="ml-1.5"
                  title="Pré-registrado: ainda não criou conta."
                >
                  Pendente
                </Badge>
              )}
            </Label>
            <Switch
              id={`member-${m.userId}`}
              checked={isParticipant(m, participantOverrides)}
              onCheckedChange={(checked) =>
                setParticipantOverrides((prev) => ({
                  ...prev,
                  [m.userId]: checked,
                }))
              }
            />
          </div>
          {isParticipant(m, participantOverrides) && (
            <div className="flex items-center gap-4 pl-1 text-xs text-muted-foreground">
              <label
                htmlFor={`weight-${m.userId}`}
                className="flex items-center gap-1.5"
              >
                peso
                <Input
                  id={`weight-${m.userId}`}
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={weightValue(m, weightInputs)}
                  onChange={(e) =>
                    setWeightInputs((prev) => ({
                      ...prev,
                      [m.userId]: e.target.value,
                    }))
                  }
                  className="h-7 w-16"
                  aria-label={`Peso de ${m.name}`}
                />
              </label>
              <label
                htmlFor={`cap-${m.userId}`}
                className="flex items-center gap-1.5"
              >
                limite
                <Input
                  id={`cap-${m.userId}`}
                  type="number"
                  min={1}
                  placeholder="—"
                  value={capValue(m, capInputs)}
                  onChange={(e) =>
                    setCapInputs((prev) => ({
                      ...prev,
                      [m.userId]: e.target.value,
                    }))
                  }
                  className="h-7 w-16"
                  aria-label={`Limite de docs de ${m.name}`}
                />
              </label>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
