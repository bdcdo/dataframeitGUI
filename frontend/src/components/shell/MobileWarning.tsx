"use client";

import { useState, useEffect, useRef } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MobileWarning() {
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // The dialog stays mounted (closed => display:none) so we can drive it via
  // showModal()/close(); showModal() gives us the top layer, focus trap, and
  // initial focus for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const shouldShow = isMobile === true && !dismissed;
    if (shouldShow && !dialog.open) dialog.showModal();
    else if (!shouldShow && dialog.open) dialog.close();
  }, [isMobile, dismissed]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="mobile-warning-title"
      // `cancel` fires only on Escape (not on the programmatic close above), so
      // resizing desktop -> mobile re-shows the warning instead of staying hidden.
      onCancel={() => setDismissed(true)}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-background/95 p-6 text-foreground backdrop:bg-transparent"
    >
      <div className="flex h-full items-center justify-center">
        <div className="max-w-sm space-y-4 text-center">
          <Monitor className="mx-auto size-12 text-brand" />
          <h2 id="mobile-warning-title" className="text-lg font-semibold">
            Use um computador
          </h2>
          <p className="text-sm text-muted-foreground">
            Esta plataforma foi projetada para telas maiores. Para a melhor
            experiência, acesse pelo computador.
          </p>
          <Button variant="outline" onClick={() => setDismissed(true)}>
            Continuar mesmo assim
          </Button>
        </div>
      </div>
    </dialog>
  );
}
