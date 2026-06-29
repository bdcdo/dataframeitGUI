"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { getModelsForProvider, type Provider } from "@/lib/model-registry";
import { cn } from "@/lib/utils";

interface ModelComboboxProps {
  provider: string;
  model: string;
  triggerLabel: string;
  onSelectModel: (model: string) => void;
}

export function ModelCombobox({
  provider,
  model,
  triggerLabel,
  onSelectModel,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listboxId = useId();

  const providerModels = getModelsForProvider(provider as Provider);
  const standardModels = providerModels.filter((m) => m.category === "standard");
  const reasoningModels = providerModels.filter(
    (m) => m.category === "reasoning",
  );

  const select = (value: string) => {
    onSelectModel(value);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          className="w-full justify-between font-normal"
        >
          {triggerLabel || model || "Selecionar modelo..."}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command>
          <CommandInput
            placeholder="Buscar modelo..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList id={listboxId}>
            <CommandEmpty>
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded-sm"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (search) select(search);
                }}
              >
                Usar modelo personalizado
              </button>
            </CommandEmpty>
            {reasoningModels.length > 0 && (
              <CommandGroup heading="Raciocínio">
                {reasoningModels.map((m) => (
                  <CommandItem
                    key={m.model}
                    value={m.model}
                    onSelect={select}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        model === m.model ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {m.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {standardModels.length > 0 && (
              <CommandGroup heading="Padrão">
                {standardModels.map((m) => (
                  <CommandItem
                    key={m.model}
                    value={m.model}
                    onSelect={select}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        model === m.model ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {m.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
