"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useRef } from "react";
import { requireSupabaseToken } from "@/lib/api";
import { readSupabaseUidFromMetadata } from "@/lib/clerk-supabase-uid";

/** Devolve a função que busca o session token para uma chamada ao FastAPI, já
 * com a regra de `requireSupabaseToken`: token sem o vínculo não sai quando a
 * conta ainda não concluiu o acesso (#532).
 *
 * A função é estável entre renders (lê `getToken` e a conta por ref), então
 * serve de dependência de effect e de callback sem religar um polling em curso.
 * A ref é atualizada num effect, não no render — escrever em ref no corpo do
 * componente é erro de `react-hooks/refs`. */
export function useSupabaseToken(): () => Promise<string> {
  const { getToken } = useAuth();
  const { user } = useUser();
  const latest = useRef({ getToken, user });
  useEffect(() => {
    latest.current = { getToken, user };
  });
  return useCallback(
    () =>
      requireSupabaseToken(latest.current.getToken, () =>
        Boolean(readSupabaseUidFromMetadata(latest.current.user ?? null)),
      ),
    [],
  );
}
