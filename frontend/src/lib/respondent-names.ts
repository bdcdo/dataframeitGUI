// Autoria exibida da resposta humana (#622). `responses.respondent_name` é
// gravado no save e congela o que o perfil tinha naquele dia — o e-mail, para
// quem só preencheu o nome depois. As leituras derivam o nome do perfil e ficam
// com a coluna como fallback (perfil sem nome, ex-membro, resposta LLM).

import type { SupabaseServerClient } from "@/lib/supabase/server";

interface ProfileNameParts {
  first_name: string | null;
  last_name: string | null;
}

interface AuthoredRow {
  respondent_type: string;
  respondent_id?: string | null;
  respondent_name?: string | null;
}

/** id do membro -> nome do perfil; só entra quem tem nome. */
export type ProfileNames = ReadonlyMap<string, string>;

// Nome do perfil, ou `null` enquanto ele não tem nome. O trim impede que um
// nome só de espaços conte como nome.
export function profileFullName(
  profile: ProfileNameParts | null | undefined,
): string | null {
  const name = [profile?.first_name, profile?.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

// Parte dos membros do projeto, e não dos ids das respostas, para correr em
// paralelo com a leitura das respostas. `respondent_id` é sempre o membro
// canônico, e a RLS de `profiles` só mostra colegas de projeto: quem saiu do
// projeto fica com o nome gravado. Falha de leitura também: a tela segue
// usável com o nome gravado, e o erro vai para o log.
export async function fetchProfileNames(
  supabase: Pick<SupabaseServerClient, "from">,
  projectId: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("project_members")
    .select("user_id, profiles(first_name, last_name)")
    .eq("project_id", projectId);
  if (error) {
    console.error(
      "fetchProfileNames: leitura dos perfis falhou; a autoria fica com o nome gravado",
      error.message,
    );
    return new Map();
  }
  const names = new Map<string, string>();
  for (const row of data ?? []) {
    const name = profileFullName(
      row.profiles as unknown as ProfileNameParts | null,
    );
    if (name) names.set(row.user_id, name);
  }
  return names;
}

export function respondentDisplayName(
  row: AuthoredRow,
  names: ProfileNames,
): string | null {
  const recorded = row.respondent_name ?? null;
  if (row.respondent_type !== "humano" || !row.respondent_id) return recorded;
  return names.get(row.respondent_id) ?? recorded;
}

/** As mesmas linhas, com `respondent_name` das humanas vindo do perfil. */
export function withProfileNames<T extends AuthoredRow>(
  rows: readonly T[] | null | undefined,
  names: ProfileNames,
): T[] {
  return (rows ?? []).map((row) => {
    const name = respondentDisplayName(row, names);
    return name === (row.respondent_name ?? null)
      ? row
      : { ...row, respondent_name: name };
  });
}
