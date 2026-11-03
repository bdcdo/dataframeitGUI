import { useEffect } from "react";
import { warmUpApi } from "@/lib/api";

// O proxy do Fly pausa a API depois de "alguns minutos" sem tráfego (valor não
// documentado); pingar a cada 4 min mantém a API acordada enquanto a aba está
// visível na maior parte do tempo, e quando a pausa vence entre dois pings a
// retomada leva centenas de milissegundos. Aba escondida não pinga, então uma
// aba esquecida em segundo plano não segura a máquina ligada.
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
