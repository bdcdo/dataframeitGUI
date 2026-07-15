"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DocumentSelector } from "./DocumentSelector";
import {
  MAX_RESPONSE_COUNT,
  MAX_SAMPLE_SIZE,
  type FilterMode,
  type RunFilter,
} from "./run-filter";

interface RunFilterControlsProps {
  projectId: string;
  filter: RunFilter;
  validationError: string | null;
  onChange: (patch: Partial<RunFilter>) => void;
}

function numericInputValue(value: string): number | null {
  return value === "" ? null : Number(value);
}

export function RunFilterControls({
  projectId,
  filter,
  validationError,
  onChange,
}: RunFilterControlsProps) {
  return (
    <RadioGroup
      value={filter.mode}
      onValueChange={(mode) => onChange({ mode: mode as FilterMode })}
      className="gap-3"
    >
      <div className="flex items-center gap-2">
        <RadioGroupItem value="all" id="filter-all" />
        <Label htmlFor="filter-all" className="text-sm font-normal">
          Todos os documentos
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <RadioGroupItem value="pending" id="filter-pending" />
        <Label htmlFor="filter-pending" className="text-sm font-normal">
          Apenas pendentes (sem resposta LLM)
        </Label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="max_responses" id="filter-max-responses" />
          <Label htmlFor="filter-max-responses" className="text-sm font-normal">
            Documentos com até N respostas LLM
          </Label>
        </div>
        {filter.mode === "max_responses" && (
          <div className="ml-6">
            <Input
              type="number"
              min={0}
              max={MAX_RESPONSE_COUNT}
              step={1}
              value={filter.maxResponseCount ?? ""}
              onChange={(event) =>
                onChange({
                  maxResponseCount: numericInputValue(event.target.value),
                })
              }
              aria-invalid={validationError !== null}
              aria-describedby={
                validationError ? "max-response-count-error" : undefined
              }
              className="w-24"
            />
            {validationError && (
              <p
                id="max-response-count-error"
                role="alert"
                className="mt-1 text-xs text-destructive"
              >
                {validationError}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="random_sample" id="filter-random" />
          <Label htmlFor="filter-random" className="text-sm font-normal">
            Amostra aleatória
          </Label>
        </div>
        {filter.mode === "random_sample" && (
          <div className="ml-6 flex items-center gap-2">
            <Label className="text-sm text-muted-foreground">Quantidade:</Label>
            <Input
              type="number"
              min={1}
              max={MAX_SAMPLE_SIZE}
              step={1}
              value={filter.sampleSize ?? ""}
              onChange={(event) =>
                onChange({ sampleSize: numericInputValue(event.target.value) })
              }
              aria-invalid={validationError !== null}
              aria-describedby={validationError ? "sample-size-error" : undefined}
              className="w-24"
            />
            {validationError && (
              <p id="sample-size-error" role="alert" className="text-xs text-destructive">
                {validationError}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="specific" id="filter-specific" />
          <Label htmlFor="filter-specific" className="text-sm font-normal">
            Documentos específicos
          </Label>
        </div>
        {filter.mode === "specific" && (
          <div className="ml-6">
            <DocumentSelector
              projectId={projectId}
              selectedIds={filter.selectedDocumentIds}
              onSelectionChange={(selectedDocumentIds) =>
                onChange({ selectedDocumentIds })
              }
            />
          </div>
        )}
      </div>
    </RadioGroup>
  );
}
