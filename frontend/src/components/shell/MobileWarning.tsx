"use client";

import { useEffect, useRef } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MobileWarning() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // `<dialog>`/showModal() is an imperative DOM API, so we drive it directly
  // from the resize subscription and the dismiss handlers instead of bridging
  // state -> effect. `dismissed` never affects render (the dialog is controlled
  // imperatively), so a ref is the right tool — no re-renders, no state/effect
  // sync to flag.
  const dismissedRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const sync = () => {
      const shouldShow = window.innerWidth < 768 && !dismissedRef.current;
      if (shouldShow && !dialog.open) dialog.showModal();
      else if (!shouldShow && dialog.open) dialog.close();
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  function dismiss() {
    dismissedRef.current = true;
    dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="mobile-warning-title"
      // Escape closes a modal <dialog> natively; just record the dismissal so a
      // later resize back to mobile doesn't re-open it.
      onCancel={() => {
        dismissedRef.current = true;
      }}
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
          <Button variant="outline" onClick={dismiss}>
            Continuar mesmo assim
          </Button>
        </div>
      </div>
    </dialog>
  );
}
