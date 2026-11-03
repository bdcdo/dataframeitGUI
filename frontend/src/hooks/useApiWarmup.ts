import { useEffect } from "react";
import { warmUpApi } from "@/lib/api";

// Feito para a API com autostop ligado, que o proxy do Fly pausava depois de
// "alguns minutos" sem tráfego: pingar a cada 4 min a mantinha acordada com a
// aba visível. Hoje a API fica sempre ligada (backend/fly.toml) e o ping não
// muda nada; ele fica para o caso de o autostop voltar em outra forma. Aba
// escondida não pinga, então uma aba esquecida não seguraria a máquina ligada.
export const API_WARMUP_INTERVAL_MS = 4 * 60 * 1000;

export function useApiWarmup(): void {
  useEffect(() => {
    const warmUpIfVisible = () => {
      if (document.visibilityState === "visible") warmUpApi();
    };
    warmUpIfVisible();
    const interval = window.setInterval(warmUpIfVisible, API_WARMUP_INTERVAL_MS);
    document.addEventListener("visibilitychange", warmUpIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", warmUpIfVisible);
    };
  }, []);
}
