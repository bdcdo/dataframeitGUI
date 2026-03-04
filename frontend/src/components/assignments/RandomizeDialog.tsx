"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { randomizeAssignments } from "@/actions/assignments";
import { toast } from "sonner";

interface RandomizeDialogProps {
  projectId: string;
}

export function RandomizeDialog({ projectId }: RandomizeDialogProps) {
  const [open, setOpen] = useState(false);
  const [perDoc, setPerDoc] = useState(2);
  const [balance, setBalance] = useState(true);
  const [loading, setLoading] = useState(false);

  const handleRandomize = async () => {
    setLoading(true);
    try {
      const result = await randomizeAssignments(projectId, perDoc, balance);
      toast.success(`${result.count} atribuições criadas!`);
      setOpen(false);
    } catch (e: any) {
      toast.error(e.message);
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">Sortear</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sortear Atribuições</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Pesquisadores por documento</label>
            <Input type="number" min={1} max={10} value={perDoc} onChange={(e) => setPerDoc(parseInt(e.target.value))} />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={balance} onChange={(e) => setBalance(e.target.checked)} className="accent-brand" />
            <span className="text-sm">Balancear carga entre pesquisadores</span>
          </label>
          <Button onClick={handleRandomize} disabled={loading} className="w-full bg-brand hover:bg-brand/90 text-brand-foreground">
            {loading ? "Sorteando..." : "Sortear"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
