"use client";

import { useState, useEffect } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MobileWarning() {
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!isMobile || dismissed) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-6">
      <div className="max-w-sm text-center space-y-4">
        <Monitor className="h-12 w-12 mx-auto text-brand" />
        <h2 className="text-lg font-semibold">Use um computador</h2>
        <p className="text-sm text-muted-foreground">
          Esta plataforma foi projetada para telas maiores. Para a melhor
          experiência, acesse pelo computador.
        </p>
        <Button variant="outline" onClick={() => setDismissed(true)}>
          Continuar mesmo assim
        </Button>
      </div>
    </div>
  );
}
