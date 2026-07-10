// Helper compartilhado (T002) para os testes de resolução de auth (US1–US3):
// monta um estado de sessão Clerk + vínculo Supabase em um dos cenários que a
// feature precisa distinguir, sem cada teste reescrever o mesmo mock de
// `currentUser` + `createSupabaseAdmin`. O shape espelha o mínimo que
// `resolveAuth`/`getAuthUser` leem: metadata `supabase_uid`, e-mail, e as
// tabelas read-only `clerk_user_mapping`, `master_users`, `profiles`.

export type LinkScenario =
  | "prepared" // metadata.supabase_uid presente e coerente com o mapping
  | "pending" // sessão sem metadata e sem mapping (vínculo ainda não criado)
  | "divergent" // metadata e mapping apontam para uuids diferentes
  | "no-email"; // sessão sem e-mail utilizável → falha técnica recuperável

export interface FakeSessionOptions {
  clerkUserId?: string;
  supabaseUid?: string;
  mappingUid?: string | null;
  email?: string | null;
  isMaster?: boolean;
  activatedAt?: string | null;
  scenario?: LinkScenario;
}

export interface FakeSession {
  clerkUserId: string;
  supabaseUid: string;
  email: string | null;
  currentUser: () => Promise<unknown>;
  admin: () => {
    from: (table: string) => Record<string, unknown>;
  };
  // contador de round-trips remotos observados na request (RC-001/RC-002/SC-002):
  // soma chamadas a currentUser() + leituras de tabela do admin.
  lookupCount: () => number;
}

// Deriva o par (metadataUid, mappingUid, email) a partir do cenário nomeado,
// deixando overrides explícitos vencerem para casos de borda pontuais.
function resolveScenario(opts: FakeSessionOptions): {
  metadataUid: string | undefined;
  mappingUid: string | null;
  email: string | null;
} {
  const uid = opts.supabaseUid ?? "sb_user_1";
  const email = opts.email ?? "user@exemplo.com";
  switch (opts.scenario ?? "prepared") {
    case "prepared":
      return { metadataUid: uid, mappingUid: uid, email };
    case "pending":
      return { metadataUid: undefined, mappingUid: null, email };
    case "divergent":
      return { metadataUid: uid, mappingUid: "sb_outro_9", email };
    case "no-email":
      return { metadataUid: undefined, mappingUid: null, email: null };
  }
}

export function makeFakeSession(opts: FakeSessionOptions = {}): FakeSession {
  const clerkUserId = opts.clerkUserId ?? "clerk_user_1";
  const supabaseUid = opts.supabaseUid ?? "sb_user_1";
  const base = resolveScenario(opts);
  // Overrides explícitos vencem o cenário nomeado, para casos de borda.
  const metadataUid = base.metadataUid;
  const mappingUid = opts.mappingUid !== undefined ? opts.mappingUid : base.mappingUid;
  const email = opts.email !== undefined ? opts.email : base.email;

  let lookups = 0;

  const currentUser = async () => {
    lookups++;
    return {
      id: clerkUserId,
      publicMetadata: metadataUid ? { supabase_uid: metadataUid } : {},
      emailAddresses: email ? [{ emailAddress: email }] : [],
      firstName: "Nome",
      lastName: "Sobrenome",
    };
  };

  const admin = () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit", "update"]) {
        builder[m] = () => builder;
      }
      const resolveData = () => {
        lookups++;
        if (table === "clerk_user_mapping") {
          return {
            data: mappingUid ? { supabase_user_id: mappingUid } : null,
            error: null,
          };
        }
        if (table === "master_users") {
          return {
            data: opts.isMaster ? { user_id: supabaseUid } : null,
            error: null,
          };
        }
        if (table === "profiles") {
          return {
            data: { activated_at: opts.activatedAt ?? "2026-01-01" },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      builder.maybeSingle = async () => resolveData();
      builder.single = async () => resolveData();
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve(resolveData());
      return builder;
    },
  });

  return {
    clerkUserId,
    supabaseUid,
    email,
    currentUser,
    admin,
    lookupCount: () => lookups,
  };
}

